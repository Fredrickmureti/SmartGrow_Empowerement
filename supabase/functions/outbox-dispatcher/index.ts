// Wave 2 · Phase D — Durable outbox dispatcher.
//
// Invoked by pg_cron every 10s. Claims server-scope events from
// business_event_outbox (per org, atomic via FOR UPDATE SKIP LOCKED),
// dispatches to a per-topic handler, and calls complete_business_event
// which auto-DLQs after max_attempts.
//
// The browser-side BusinessSaga now only claims 'host' events (drawer,
// printer). This function only claims 'server' events. Both cannot pick
// up the same row.
//
// Handler registry is intentionally minimal in Phase D; Phase E fills it
// in (loyalty, fiscal transmission, analytics projections, …). Unknown
// events succeed as no-ops so the outbox drains instead of accumulating
// while handlers are still being landed.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The dispatcher is intentionally open (verify_jwt=false). It only drains
// pending business_event_outbox rows atomically via RPC — no user data is
// returned. Callers still need Supabase's anon key on Authorization by the
// platform's default routing, and the pg_cron caller passes it.

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type OutboxRow = {
  id: string;
  org_id: string;
  branch_id: string | null;
  warehouse_id: string | null;
  event_type: string;
  source_doc_type: string;
  source_doc_id: string;
  payload: unknown;
  attempts: number;
  created_at: string;
};

type HandlerFn = (row: OutboxRow) => Promise<void>;

// --- Phase E handlers -----------------------------------------------------
// Each handler must be idempotent (the outbox retries on failure) and must
// throw on unrecoverable errors so the row is dead-lettered after
// max_attempts. Handlers should NOT call user-tenant supabase clients —
// only the service-role `admin` client.

async function handlePosSaleCommitted(row: OutboxRow): Promise<void> {
  const payload = (row.payload ?? {}) as { transaction_id?: string };
  const txnId = payload.transaction_id ?? row.source_doc_id;
  if (!txnId) throw new Error("pos.sale.committed: missing transaction_id");

  // 1. Loyalty accrual — idempotent per pos_transaction_id.
  const { error: loyaltyErr } = await admin.rpc(
    "apply_loyalty_accrual_for_sale",
    { p_transaction_id: txnId },
  );
  if (loyaltyErr) throw new Error(`loyalty accrual: ${loyaltyErr.message}`);

  // 2. Wave 2 · Phase E-2 — read-model projections (daily rollup +
  //    customer purchase history). Idempotent via pos_projection_apply_log
  //    and the UNIQUE(transaction_id) constraint on the history table, so
  //    outbox retries never double-count.
  const { error: projErr } = await admin.rpc(
    "project_pos_sale_committed",
    { p_transaction_id: txnId },
  );
  if (projErr) throw new Error(`sales projection: ${projErr.message}`);

  // 3. Fiscal transmission (KRA eTIMS) — best-effort. Not every org has
  //    eTIMS configured; the function itself decides whether to transmit.
  //    We swallow errors here so a fiscal outage does not block the whole
  //    sale-committed handler; eTIMS retries live inside etims-transmit.
  try {
    await admin.functions.invoke("etims-transmit", {
      body: { doc_type: "pos", transaction_id: txnId, org_id: row.org_id },
    });
  } catch (e) {
    console.warn(JSON.stringify({
      event_id: row.id, event_type: row.event_type,
      warn: "etims-transmit failed", error: e instanceof Error ? e.message : String(e),
    }));
  }
}

async function handleInventoryMovementRecorded(row: OutboxRow): Promise<void> {
  // Reorder-alert recompute lives in check_low_stock_products; call it
  // per-org so subsequent movements trigger fresh alerts. This is cheap
  // enough (single RPC, per event batch) and idempotent.
  //
  // Inventory Foundation Wave · Phase 6: this topic now covers EVERY stock
  // movement (previously only point-of-sale movements reached the outbox),
  // so reorder recompute finally runs for receipts, transfers, adjustments,
  // scrap and counts as well.
  const { error } = await admin.rpc("check_low_stock_products");
  if (error) throw new Error(`reorder recompute: ${error.message}`);
}

// Inventory lot / serial / valuation lifecycle topics (Phase 6). Their state
// is already durable in `lot_quarantine`, `product_recalls`, `stock_serials`
// and `inventory_cost_revaluations`; the events exist for audit, analytics and
// future notification consumers. Registered explicitly so the closed registry
// does not dead-letter them.
async function handleInventoryLifecycleRecorded(row: OutboxRow): Promise<void> {
  console.log(JSON.stringify({
    event_id: row.id, event_type: row.event_type,
    source_doc_type: row.source_doc_type, source_doc_id: row.source_doc_id,
    outcome: "recorded",
  }));
}

// --- Phase F handlers -----------------------------------------------------
// Route capture / reversal events into the current open settlement batch.
// `pos_card_settlement_apply` is idempotent (unique on source_event_id and
// on (payment_id, kind)) so outbox retries never double-count.
async function handleCardSettlementLine(
  row: OutboxRow,
  kind: "capture" | "reversal",
): Promise<void> {
  const payload = (row.payload ?? {}) as {
    payment_id?: string;
    amount?: number;
    authorized_amount?: number;
  };
  const paymentId = payload.payment_id ?? row.source_doc_id;
  if (!paymentId) throw new Error(`${row.event_type}: missing payment_id`);

  // Fetch business/branch + payment-method provider_key. We can't rely on
  // the trigger payload alone since provider_key lives on pos_payment_methods.
  const { data: pay, error: payErr } = await admin
    .from("pos_transaction_payments")
    .select("id, business_id, branch_id, organization_id, amount, authorized_amount, payment_method")
    .eq("id", paymentId)
    .maybeSingle();
  if (payErr) throw new Error(`fetch payment: ${payErr.message}`);
  if (!pay) throw new Error(`payment ${paymentId} not found`);

  // Resolve provider_key from the payment_methods catalog for this business.
  // Fall back to the payment_method code if no catalog entry (legacy rows).
  let providerKey: string = pay.payment_method ?? "unknown";
  const { data: method } = await admin
    .from("pos_payment_methods")
    .select("provider_key")
    .eq("business_id", pay.business_id)
    .eq("method_code", pay.payment_method)
    .maybeSingle();
  if (method?.provider_key) providerKey = method.provider_key;

  const amount = payload.amount ?? pay.authorized_amount ?? pay.amount ?? 0;

  const { error } = await admin.rpc("pos_card_settlement_apply", {
    p_event_id:     row.id,
    p_payment_id:   paymentId,
    p_kind:         kind,
    p_amount:       amount,
    p_org_id:       pay.organization_id ?? row.org_id,
    p_business_id:  pay.business_id,
    p_branch_id:    pay.branch_id,
    p_provider_key: providerKey,
  });
  if (error) throw new Error(`settlement apply (${kind}): ${error.message}`);
}

async function handleSettlementCardClosed(row: OutboxRow): Promise<void> {
  // Wave 2 · Phase F.6 — post the closed batch to the general ledger.
  // pos_card_settlement_post_gl is idempotent (settlement-id apply-log +
  // post_journal_entry_atomic source-id dedupe) so outbox retries are safe.
  const settlementId =
    (row.payload as { settlement_id?: string } | null)?.settlement_id ?? row.source_doc_id;
  if (!settlementId) throw new Error("settlement.card.closed: missing settlement_id");
  const { error } = await admin.rpc("pos_card_settlement_post_gl", {
    p_settlement_id: settlementId,
  });
  if (error) throw new Error(`settlement GL post: ${error.message}`);
}

// S5 — statement-centric GL posting, now routed through the single
// Accounting Posting Engine (see .lovable/plan.md §4.3, migration
// creating public.accounting_post_event). The dispatcher does NOT call
// producer-specific writers anymore; it resolves the accounting_event
// for the statement and invokes the engine, then translates the
// engine's AccountingPostingResult into an outbox outcome.
//
// Contract enforced here (B1 + B3):
//   outcome='posted' | 'noop'         → outbox 'succeeded'
//   outcome='needs_mapping' | 'invalid' → thrown as contract violation
//                                         so the row goes to failed / DLQ
//                                         and is visible to accountants
//                                         (they resolve via the new
//                                         workspace, not via retry).
//   outcome='deferred' or missing     → thrown; outbox retries with backoff.
//   thrown exception                  → outbox retries with backoff.
type AccountingPostingResult = {
  event_id?: string;
  outcome?: "posted" | "noop" | "needs_mapping" | "invalid" | "deferred";
  journal_entry_id?: string | null;
  diagnostics?: unknown;
};

async function handlePosStatementPostingRequested(row: OutboxRow): Promise<void> {
  const payload = (row.payload ?? {}) as {
    statement_id?: string;
    accounting_event_id?: string | null;
  };
  const statementId = payload.statement_id ?? row.source_doc_id;
  if (!statementId) {
    throw new Error(
      "posting.contract_violation: pos.statement.posting.requested missing statement_id",
    );
  }

  // B6: prefer the accounting_event_id carried in the payload (written
  // by the producer trigger). Fallback to the resolver RPC only for
  // legacy rows enqueued before B6 landed.
  let eventId: string | null = payload.accounting_event_id ?? null;
  if (!eventId) {
    const { data, error: resolveError } = await admin.rpc(
      "accounting_event_for_pos_statement",
      { p_statement_id: statementId },
    );
    if (resolveError) {
      throw new Error(`accounting_event lookup: ${resolveError.message}`);
    }
    eventId = (data as string | null) ?? null;
  }
  if (!eventId) {
    throw new Error(
      `posting.contract_violation: no accounting_event exists for pos_statement ${statementId} — producer trigger dual-write was skipped or failed`,
    );
  }

  const { data, error } = await admin.rpc("accounting_post_event", {
    p_event_id: eventId,
    p_idempotency_key: `outbox:${row.id}`,
  });
  if (error) throw new Error(`accounting_post_event: ${error.message}`);

  const result = (data ?? null) as AccountingPostingResult | null;
  if (!result || typeof result !== "object" || !result.outcome) {
    throw new Error(
      `posting.contract_violation: accounting_post_event returned no outcome for event ${eventId}: ${JSON.stringify(result)}`,
    );
  }

  switch (result.outcome) {
    case "posted":
    case "noop":
      return; // outbox → succeeded
    case "needs_mapping":
    case "invalid":
      // These are configuration problems, not transient. Throwing here
      // marks the outbox row failed, which surfaces to admins. The
      // authoritative state ('needs_mapping' / 'invalid') lives on the
      // accounting_event itself — the workspace acts on that, not on
      // the outbox.
      throw new Error(
        `posting.blocked: event ${eventId} → ${result.outcome} — ${JSON.stringify(result.diagnostics ?? {})}`,
      );
    case "deferred":
      throw new Error(
        `posting.deferred: event ${eventId} — ${JSON.stringify(result.diagnostics ?? {})}`,
      );
    default:
      throw new Error(
        `posting.contract_violation: unknown outcome ${result.outcome} for event ${eventId}`,
      );
  }
}


// Phase E/F map. Extend with one entry per newly-durable topic.
//
// B1 (plan .lovable/plan.md § 4.1): unknown topics used to be silently
// marked succeeded ("so the outbox drains"), which is what caused the
// POS Posting Queue to lie about statement 4344c0db (see
// docs/audit/pos-posting-silent-noop.md). The registry is now closed:
// unknown topics are `failed` with a structured `posting.contract_violation`
// diagnostic, so they retry into the DLQ and become visible instead of
// disappearing. Adding a new topic must always be paired with a handler.
// --- Phase 6b handlers: Legal Order fabric --------------------------------
// The FSM (`garnishment_transition`) and payment poster
// (`post-garnishment-payment`) emit one outbox row per lifecycle transition
// plus one per posted payment. We (a) project payment_posted into the
// legal_order_remittance_lines finance ledger and (b) fan out in-app
// notifications for every lifecycle event. Both RPCs are idempotent via
// `source_event_id`, so outbox retries never double-book.

async function fanoutFinanceAndEss(row: OutboxRow): Promise<void> {
  // ADR-0094 Phase 5 — per-recipient drift check + ESS employee ping.
  // Both RPCs are idempotent via legal_order_subscriber_dispatch_log.
  const { error: driftErr } = await admin.rpc("legal_order_check_finance_drift", {
    p_event_id: row.id,
    p_org_id:   row.org_id,
    p_business: null,
    p_topic:    row.event_type,
    p_payload:  row.payload ?? {},
  });
  if (driftErr) throw new Error(`finance drift: ${driftErr.message}`);

  const { error: essErr } = await admin.rpc("legal_order_notify_employee", {
    p_event_id: row.id,
    p_org_id:   row.org_id,
    p_business: null,
    p_topic:    row.event_type,
    p_payload:  row.payload ?? {},
  });
  if (essErr) throw new Error(`ess notify: ${essErr.message}`);
}

async function handleLegalOrderPaymentPosted(row: OutboxRow): Promise<void> {
  const { error: remitErr } = await admin.rpc(
    "legal_order_apply_payment_remittance",
    {
      p_event_id: row.id,
      p_org_id:   row.org_id,
      p_business: row.branch_id ? null : null, // resolved from payload below
      p_payload:  row.payload ?? {},
    },
  );
  if (remitErr) throw new Error(`remittance projection: ${remitErr.message}`);

  // Also notify — payment posted is finance-visible.
  const { error: notifErr } = await admin.rpc("legal_order_notify_event", {
    p_event_id: row.id,
    p_org_id:   row.org_id,
    p_business: null,
    p_topic:    row.event_type,
    p_payload:  row.payload ?? {},
  });
  if (notifErr) throw new Error(`notify: ${notifErr.message}`);

  await fanoutFinanceAndEss(row);
}

async function handleLegalOrderLifecycle(row: OutboxRow): Promise<void> {
  const { error } = await admin.rpc("legal_order_notify_event", {
    p_event_id: row.id,
    p_org_id:   row.org_id,
    p_business: null,
    p_topic:    row.event_type,
    p_payload:  row.payload ?? {},
  });
  if (error) throw new Error(`notify: ${error.message}`);
}

async function handleLegalOrderStatusChanged(row: OutboxRow): Promise<void> {
  // Canonical status_changed event (ADR-0094 Phase 5). Admin notify is
  // already handled by the specific lifecycle topics above; this handler
  // exists to drive finance + ESS via the shared fanout.
  await fanoutFinanceAndEss(row);
}

// --- RFQ sourcing fabric -------------------------------------------------
// The RFQ domain owns the *intent* to invite a supplier; delivery belongs to
// the communication subsystem. `rfq_release` / `rfq_invitation_resend` queue
// invitations and emit rfq.supplier_invitation_requested; this handler drains
// that intent into actual email sends. A provider failure marks the single
// invitation `failed` (retried on the next attempt up to 5) and never rolls
// back the RFQ lifecycle state.
async function handleRfqInvitationRequested(row: OutboxRow): Promise<void> {
  const payload = (row.payload ?? {}) as { rfq_id?: string };
  const rfqId = payload.rfq_id ?? row.source_doc_id;
  if (!rfqId) throw new Error("rfq.supplier_invitation_requested: missing rfq_id");

  const { data: claimed, error: claimErr } = await admin.rpc(
    "rfq_invitations_claim_for_delivery",
    { _rfq_id: rfqId, _max_attempts: 5, _limit: 50 },
  );
  if (claimErr) throw new Error(`claim invitations: ${claimErr.message}`);

  const invitations = (claimed ?? []) as Array<{
    invitation_id: string;
    supplier_id: string;
    contact_email: string | null;
    rfq_number: string;
    response_deadline: string | null;
    attempt: number;
  }>;

  let permanentFailures = 0;
  for (const inv of invitations) {
    if (!inv.contact_email) {
      await admin.rpc("rfq_invitation_record_delivery", {
        _invitation_id: inv.invitation_id,
        _state: "failed",
        _error: "No email address on file for this supplier",
      });
      permanentFailures++;
      continue;
    }
    try {
      const { data: documentRecordId, error: docErr } = await admin.rpc(
        "rfq_ensure_document_record",
        { _rfq_id: rfqId, _supplier_id: inv.supplier_id },
      );
      if (docErr || typeof documentRecordId !== "string") {
        throw new Error(`freeze RFQ invitation artifact: ${docErr?.message ?? "no document record"}`);
      }
      const deadline = inv.response_deadline
        ? new Date(inv.response_deadline).toISOString().slice(0, 10)
        : null;
      const { data, error } = await admin.functions.invoke("send-document-email", {
        body: {
          documentType: "rfq",
          documentId: rfqId,
          documentRecordId,
          recipientEmail: inv.contact_email,
          subject: `Request for Quotation ${inv.rfq_number}`,
          message:
            `You have been invited to quote on request for quotation ${inv.rfq_number}.` +
            (deadline ? `\n\nResponses are due by ${deadline}.` : "") +
            `\n\nPlease submit your quotation through the supplier portal.`,
          autoGeneratePdf: true,
        },
      });
      if (error) throw new Error(error.message ?? String(error));
      if (data && (data as { success?: boolean }).success === false) {
        throw new Error((data as { error?: string }).error ?? "send-document-email reported failure");
      }
      await admin.rpc("rfq_invitation_record_delivery", {
        _invitation_id: inv.invitation_id, _state: "sent", _error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.rpc("rfq_invitation_record_delivery", {
        _invitation_id: inv.invitation_id, _state: "failed", _error: msg,
      });
      console.warn(JSON.stringify({
        event_id: row.id, event_type: row.event_type,
        invitation_id: inv.invitation_id, warn: "invitation delivery failed", error: msg,
      }));
      permanentFailures++;
    }
  }

  // The event itself succeeds: per-invitation outcomes are durable on
  // rfq_invitations. Requeueing the whole event would re-send to suppliers
  // that already received it. Retries are user-driven (resend) or picked up
  // by the next requested event, which re-claims only queued/failed rows.
  console.log(JSON.stringify({
    event_id: row.id, event_type: row.event_type, rfq_id: rfqId,
    attempted: invitations.length, failed: permanentFailures,
  }));
}

// Lifecycle topics whose state is already durable in `rfqs` /
// `rfq_quotations` / `rfq_awards`. They exist for audit, analytics and
// (later) notification consumers. Registered explicitly so the closed
// registry does not dead-letter them, and so adding a real consumer later is
// a one-line change rather than a schema archaeology exercise.
async function handleRfqLifecycleNoop(row: OutboxRow): Promise<void> {
  console.log(JSON.stringify({
    event_id: row.id, event_type: row.event_type,
    source_doc_id: row.source_doc_id, outcome: "recorded",
  }));
}

const HANDLERS: Record<string, HandlerFn> = {
  "pos.sale.committed":              handlePosSaleCommitted,
  "inventory.movement.recorded":     handleInventoryMovementRecorded,

  // Inventory lot / serial / valuation lifecycle (Foundation Wave · Phase 6)
  "inventory.lot.quarantined":                handleInventoryLifecycleRecorded,
  "inventory.lot.released":                   handleInventoryLifecycleRecorded,
  "inventory.lot.recall_opened":              handleInventoryLifecycleRecorded,
  "inventory.lot.recall_closed":              handleInventoryLifecycleRecorded,
  "inventory.serial.status_changed":          handleInventoryLifecycleRecorded,
  "inventory.valuation.revalued":             handleInventoryLifecycleRecorded,
  "inventory.valuation.revaluation_reversed": handleInventoryLifecycleRecorded,

  // Phase 8 behavioural sweep: these two were emitted by
  // `physical_count_post` / `_physical_count_post_side_effects` but were never
  // registered here nor in `business_event_topics`, so they dead-lettered as
  // unknown_event_type. Record-only — the state is already durable.
  "inventory.physical_count.posted":           handleInventoryLifecycleRecorded,
  "inventory.reorder.recompute":               handleInventoryLifecycleRecorded,
  "payment.card.captured":           (r) => handleCardSettlementLine(r, "capture"),
  "payment.card.reversed":           (r) => handleCardSettlementLine(r, "reversal"),
  "settlement.card.closed":          handleSettlementCardClosed,
  "pos.statement.posting.requested": handlePosStatementPostingRequested,

  // Legal Order fabric — Phase 6b lifecycle topics
  "legal_order.payment_posted":        handleLegalOrderPaymentPosted,
  "legal_order.submit":                handleLegalOrderLifecycle,
  "legal_order.approve":               handleLegalOrderLifecycle,
  "legal_order.reject":                handleLegalOrderLifecycle,
  "legal_order.activate":              handleLegalOrderLifecycle,
  "legal_order.suspend":               handleLegalOrderLifecycle,
  "legal_order.resume":                handleLegalOrderLifecycle,
  "legal_order.mark_satisfied":        handleLegalOrderLifecycle,
  "legal_order.release":               handleLegalOrderLifecycle,
  "legal_order.expire":                handleLegalOrderLifecycle,
  "legal_order.terminate_unsatisfied": handleLegalOrderLifecycle,

  // ADR-0094 Phase 5 — canonical status_changed emitted by the DB trigger
  "legal_order.status_changed":        handleLegalOrderStatusChanged,

  // RFQ / sourcing
  "rfq.supplier_invitation_requested": handleRfqInvitationRequested,
  "rfq.submitted":                     handleRfqLifecycleNoop,
  "rfq.approved":                      handleRfqLifecycleNoop,
  "rfq.revised":                       handleRfqLifecycleNoop,
  "rfq.quotation_received":            handleRfqLifecycleNoop,
  "rfq.quotation_revised":             handleRfqLifecycleNoop,
  "rfq.quotation_withdrawn":           handleRfqLifecycleNoop,
  "rfq.awarded":                       handleRfqLifecycleNoop,
  "rfq.converted_to_purchase_order":   handleRfqLifecycleNoop,
  "rfq.cancelled":                     handleRfqLifecycleNoop,
  "rfq.expired":                       handleRfqLifecycleNoop,

  // Landed cost (ADR 0077 / Phase 6). Emitted by `_emit_landed_cost_outbox`;
  // the voucher, its inventory revaluation and its journal are already
  // durable, so these are record-only lifecycle topics.
  "procurement.landed_cost.submitted": handleInventoryLifecycleRecorded,
  "procurement.landed_cost.allocated": handleInventoryLifecycleRecorded,
  "procurement.landed_cost.posted":    handleInventoryLifecycleRecorded,
  "procurement.landed_cost.reversed":  handleInventoryLifecycleRecorded,

  // P0-4 (milk simulation, 2026-08-16). These purchasing / warehouse /
  // inventory lifecycle topics were emitted by database triggers but had no
  // dispatcher entry, so every one of them dead-lettered as
  // `posting.contract_violation: unknown_event_type`. The underlying state
  // (PO status, ASN, GRN, stock movements, journals) is already durable and
  // written in-transaction, so these are record-only: they exist for lineage,
  // subscribers and analytics, not to drive the write.
  "procurement.po.submitted":          handleInventoryLifecycleRecorded,
  "procurement.po.approved":           handleInventoryLifecycleRecorded,
  "procurement.asn.created":           handleInventoryLifecycleRecorded,
  "procurement.asn.dispatched":        handleInventoryLifecycleRecorded,
  "procurement.asn.in_transit":        handleInventoryLifecycleRecorded,
  "procurement.asn.arrived":           handleInventoryLifecycleRecorded,
  "procurement.gr.posted":             handleInventoryLifecycleRecorded,
  "procurement.grn.received":          handleInventoryLifecycleRecorded,
  "goods_receipt.posted":              handleInventoryLifecycleRecorded,
  "product.created":                   handleInventoryLifecycleRecorded,
  "payment.received":                  handleInventoryLifecycleRecorded,
  "delivery_note.dispatched":          handleInventoryLifecycleRecorded,
  "delivery_note.completed":           handleInventoryLifecycleRecorded,
  "stock_transfer.dispatched":         handleInventoryLifecycleRecorded,
  "stock_transfer.received":           handleInventoryLifecycleRecorded,
  "warehouse.receipt.staged":          handleInventoryLifecycleRecorded,
  "warehouse.receiving.unloading":     handleInventoryLifecycleRecorded,
  "warehouse.receiving.captured":      handleInventoryLifecycleRecorded,
  "warehouse.receiving.line_captured": handleInventoryLifecycleRecorded,
  "warehouse.receiving.posted":        handleInventoryLifecycleRecorded,
  "warehouse.exception.raised":        handleInventoryLifecycleRecorded,
  "warehouse.exception.escalated":     handleInventoryLifecycleRecorded,

  // POS payment-session lifecycle. The session state machine is fully durable
  // in `pos_payment_sessions`; these topics exist for lineage/analytics only
  // and had no consumer, so they dead-lettered too.
  "pos.payment.session.opened":        handleInventoryLifecycleRecorded,
  "pos.payment.session.committed":     handleInventoryLifecycleRecorded,
  "pos.payment.tender.recorded":       handleInventoryLifecycleRecorded,
  "shift.opened":                      handleInventoryLifecycleRecorded,

  // CRM lead/opportunity lifecycle (CRM domain audit · Phase 3). The
  // authoritative state lives in `crm_leads` and the immutable audit trail in
  // `crm_lead_history`; these topics exist for lineage, analytics and future
  // notification consumers. Record-only — CRM never posts to the ledger.
  "crm.lead.qualified":                handleInventoryLifecycleRecorded,
  "crm.lead.stage_changed":            handleInventoryLifecycleRecorded,
  "crm.lead.won":                      handleInventoryLifecycleRecorded,
  "crm.lead.lost":                     handleInventoryLifecycleRecorded,
  "crm.lead.reopened":                 handleInventoryLifecycleRecorded,
  "crm.lead.reassigned":               handleInventoryLifecycleRecorded,
  "crm.lead.revalued":                 handleInventoryLifecycleRecorded,
  "crm.lead.archived":                 handleInventoryLifecycleRecorded,
  "crm.lead.restored":                 handleInventoryLifecycleRecorded,
  "crm.lead.branch_transferred":       handleInventoryLifecycleRecorded,
  // Phase R1: the proposition step is a real, reversible lifecycle state.
  "crm.lead.proposition":              handleInventoryLifecycleRecorded,
  "crm.lead.proposition_withdrawn":    handleInventoryLifecycleRecorded,
};




// Lineage-only domains: the write is already durable in-transaction, so any
// topic under these prefixes without an explicit handler is recorded rather
// than dead-lettered. Keeps the WMS/procurement lifecycle observable without
// having to enumerate every state-machine transition here.
const RECORD_ONLY_PREFIXES = [
  "warehouse.",
  "procurement.",
  "goods_receipt.",
];

// P0-4 recurrence fix (2026-08-17). The handler map above and
// `business_event_topics` were two independent registries: a topic could be
// registered in the database and still dead-letter here as
// `unknown_event_type` (purchase_return.*, warehouse.receiving.discrepant, …).
// `business_event_topics` is the single source of truth: a topic that the
// registry knows and scopes to the server, but that has no bespoke handler,
// is lineage-only and is RECORDED, never dead-lettered. Unregistered topics
// still fail loudly — that contract is what the registration ratchet pins.
const registryCache = new Map<string, boolean>();

async function isRegisteredServerTopic(eventType: string): Promise<boolean> {
  const cached = registryCache.get(eventType);
  if (cached !== undefined) return cached;

  const { data, error } = await admin
    .from("business_event_topics")
    .select("topic_prefix, handler_scope")
    .eq("topic_prefix", eventType)
    .maybeSingle();

  if (error) return false; // fail closed: dead-letter rather than swallow
  const ok = !!data && (data.handler_scope ?? "server") === "server";
  registryCache.set(eventType, ok);
  return ok;
}

async function dispatch(row: OutboxRow): Promise<void> {
  let handler = HANDLERS[row.event_type] ??
    (RECORD_ONLY_PREFIXES.some((p) => row.event_type.startsWith(p))
      ? handleInventoryLifecycleRecorded
      : undefined);
  if (!handler && await isRegisteredServerTopic(row.event_type)) {
    handler = handleInventoryLifecycleRecorded;
  }
  if (!handler) {
    throw new Error(
      `posting.contract_violation: unknown_event_type ${row.event_type} (row ${row.id})`,
    );
  }
  await handler(row);
}

async function processOrg(orgId: string, batchSize = 25): Promise<{ ok: number; err: number }> {
  const { data, error } = await admin.rpc("claim_next_business_event", {
    p_org_id: orgId,
    p_limit: batchSize,
    p_claimant: `server-dispatcher:${crypto.randomUUID().slice(0, 8)}`,
    p_branch_id: null,
    p_handler_scope: "server",
  });
  if (error || !data) return { ok: 0, err: 0 };

  let ok = 0, err = 0;
  for (const row of data as OutboxRow[]) {
    const started = Date.now();
    try {
      await dispatch(row);
      await admin.rpc("complete_business_event", {
        p_id: row.id, p_success: true, p_error: null,
      });
      ok++;
      console.log(JSON.stringify({
        org_id: orgId, event_id: row.id, event_type: row.event_type,
        outcome: "ok", attempts: row.attempts, ms: Date.now() - started,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.rpc("complete_business_event", {
        p_id: row.id, p_success: false, p_error: msg,
      });
      err++;
      console.error(JSON.stringify({
        org_id: orgId, event_id: row.id, event_type: row.event_type,
        outcome: "err", attempts: row.attempts, ms: Date.now() - started,
        error: msg,
      }));
    }
  }
  return { ok, err };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });


  // Discover orgs with pending server-scope work. Cheap: distinct scan
  // filtered by index on (org_id, status). Cap orgs per tick to keep
  // each invocation fast.
  const { data: orgs, error } = await admin
    .from("business_event_outbox")
    .select("org_id")
    .in("status", ["pending", "failed"])
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uniqueOrgs = Array.from(new Set((orgs ?? []).map((r) => r.org_id)));
  let totalOk = 0, totalErr = 0;
  for (const orgId of uniqueOrgs) {
    const { ok, err } = await processOrg(orgId);
    totalOk += ok; totalErr += err;
  }

  return new Response(
    JSON.stringify({ orgs: uniqueOrgs.length, ok: totalOk, err: totalErr }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
