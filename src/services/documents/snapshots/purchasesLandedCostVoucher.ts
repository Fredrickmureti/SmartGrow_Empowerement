/**
 * Landed Cost Voucher snapshot builder (`purchases.landed_cost_voucher`).
 *
 * A landed cost voucher is INTERNAL costing evidence: it proves which
 * shipment charges were captured, which goods receipts they were spread
 * across, on what basis each charge was apportioned, and how much of the
 * result was capitalised into inventory versus expensed to cost of sales.
 *
 * It is NOT commercial paper. There is no "Bill To", no tax ladder and no
 * amount due — a supplier is never the audience. That is why the kind is
 * registered without an `email` intent and drawn by the dedicated
 * `landed_cost_voucher` layout instead of `generateDocumentPdf`.
 *
 * Every monetary figure in the snapshot is read back from the server-owned
 * columns the posting engine wrote (`total_amount`, `capitalized_amount`,
 * `expensed_amount`, per-allocation amounts). The browser never recomputes
 * an allocation or converts a currency here — reprints must replay exactly
 * what was booked.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface BuildLandedCostVoucherSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  /** Carried for tenancy only — the voucher is not addressed to the vendor. */
  vendorId: string | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** "goods_receipt" → "Goods receipt". */
function humanise(v: unknown): string | null {
  const s = str(v)?.replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

export async function fetchAndBuildLandedCostVoucherSnapshot(
  supabase: SupabaseClient,
  voucherId: string,
): Promise<BuildLandedCostVoucherSnapshotResult> {
  const client = supabase as unknown as SupabaseClient<never>;

  const { data, error } = await (client as any)
    .from("landed_cost_vouchers")
    .select(
      `
      id, voucher_number, status, voucher_date, posting_date,
      shipment_reference, vendor_id, source_bill_id, default_basis,
      currency, exchange_rate, exchange_rate_date,
      total_amount, total_base_amount, capitalized_amount, expensed_amount,
      notes, approval_request_id,
      allocated_at, allocated_by, posted_at, posted_by,
      journal_entry_id, reversal_journal_entry_id, reversal_reason,
      reversed_at, reversed_by, created_by, created_at,
      organization_id, business_id, branch_id
      `,
    )
    .eq("id", voucherId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildLandedCostVoucherSnapshot: voucher ${voucherId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const header = data as Record<string, unknown>;

  const [componentsRes, scopeRes, allocationsRes] = await Promise.all([
    (client as any)
      .from("landed_cost_components")
      .select(
        `
        id, description, basis, amount, base_amount, is_capitalizable,
        sort_order, expense_account_id, vendor_id,
        component_type:landed_cost_component_types(code, name)
        `,
      )
      .eq("voucher_id", voucherId),
    (client as any)
      .from("landed_cost_voucher_scope")
      .select(
        `
        id, goods_receipt_id,
        goods_receipt:goods_receipts(receipt_number, receipt_date, status)
        `,
      )
      .eq("voucher_id", voucherId),
    (client as any)
      .from("landed_cost_allocations")
      .select(
        `
        id, component_id, basis, basis_value, allocation_ratio,
        allocated_amount, capitalized_amount, expensed_amount, is_manual,
        product:products(name, sku),
        goods_receipt:goods_receipts(receipt_number)
        `,
      )
      .eq("voucher_id", voucherId),
  ]);

  const componentRows = ((componentsRes?.data ?? []) as Array<Record<string, unknown>>)
    .slice()
    .sort((a, b) => num(a["sort_order"]) - num(b["sort_order"]));

  const accountIds = [
    ...new Set(
      componentRows
        .map((c) => str(c["expense_account_id"]))
        .filter(Boolean) as string[],
    ),
  ];
  const actorIds = [
    ...new Set(
      ["created_by", "allocated_by", "posted_by", "reversed_by"]
        .map((k) => str(header[k]))
        .filter(Boolean) as string[],
    ),
  ];

  const [accountsRes, profilesRes, businessRes, journalRes] = await Promise.all([
    accountIds.length
      ? (client as any).from("accounts").select("id, code, name").in("id", accountIds)
      : Promise.resolve({ data: [] }),
    actorIds.length
      ? (client as any)
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", actorIds)
      : Promise.resolve({ data: [] }),
    header["business_id"]
      ? (client as any)
          .from("businesses")
          .select("name, base_currency")
          .eq("id", header["business_id"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    (client as any)
      .from("journal_entries")
      .select("id, entry_number")
      .in(
        "id",
        [str(header["journal_entry_id"]), str(header["reversal_journal_entry_id"])].filter(
          Boolean,
        ) as string[],
      ),
  ]);

  const accountMap = new Map<string, string | null>();
  for (const a of (accountsRes?.data ?? []) as Array<Record<string, unknown>>) {
    accountMap.set(
      String(a["id"]),
      [str(a["code"]), str(a["name"])].filter(Boolean).join(" · ") || null,
    );
  }
  const actorMap = new Map<string, string | null>();
  for (const p of (profilesRes?.data ?? []) as Array<Record<string, unknown>>) {
    actorMap.set(String(p["user_id"]), str(p["full_name"]) ?? str(p["email"]));
  }
  const journalMap = new Map<string, string | null>();
  for (const j of (journalRes?.data ?? []) as Array<Record<string, unknown>>) {
    journalMap.set(String(j["id"]), str(j["entry_number"]));
  }

  const business = (businessRes?.data ?? null) as Record<string, unknown> | null;
  const currency = str(header["currency"]) ?? str(business?.["base_currency"]) ?? "USD";
  const baseCurrency = str(business?.["base_currency"]);
  const voucherDate = String(header["voucher_date"]).slice(0, 10);

  const charges = componentRows.map((c, idx) => {
    const type = (c["component_type"] ?? null) as Record<string, unknown> | null;
    return {
      line: idx + 1,
      charge_code: str(type?.["code"]),
      charge_name: str(type?.["name"]) ?? str(c["description"]),
      description: str(c["description"]),
      basis: humanise(c["basis"]),
      amount: num(c["amount"]),
      base_amount: num(c["base_amount"]),
      treatment: c["is_capitalizable"] === true ? "Capitalised" : "Expensed",
      expense_account: accountMap.get(str(c["expense_account_id"]) ?? "") ?? null,
    };
  });

  const scope = ((scopeRes?.data ?? []) as Array<Record<string, unknown>>).map((s) => {
    const grn = (s["goods_receipt"] ?? null) as Record<string, unknown> | null;
    return {
      receipt_number: str(grn?.["receipt_number"]),
      receipt_date: str(grn?.["receipt_date"])?.slice(0, 10) ?? null,
      receipt_status: humanise(grn?.["status"]),
    };
  });

  const componentLabel = new Map<string, string | null>();
  componentRows.forEach((c, idx) => {
    const type = (c["component_type"] ?? null) as Record<string, unknown> | null;
    componentLabel.set(
      String(c["id"]),
      str(type?.["name"]) ?? str(c["description"]) ?? `Charge ${idx + 1}`,
    );
  });

  const allocations = ((allocationsRes?.data ?? []) as Array<Record<string, unknown>>).map(
    (a) => {
      const product = (a["product"] ?? null) as Record<string, unknown> | null;
      const grn = (a["goods_receipt"] ?? null) as Record<string, unknown> | null;
      return {
        charge: componentLabel.get(str(a["component_id"]) ?? "") ?? null,
        receipt_number: str(grn?.["receipt_number"]),
        product_sku: str(product?.["sku"]),
        product_name: str(product?.["name"]),
        basis: humanise(a["basis"]),
        basis_value: num(a["basis_value"]),
        allocation_ratio: num(a["allocation_ratio"]),
        allocated_amount: num(a["allocated_amount"]),
        capitalized_amount: num(a["capitalized_amount"]),
        expensed_amount: num(a["expensed_amount"]),
        is_manual: a["is_manual"] === true,
      };
    },
  );

  const auditTrail = [
    {
      event: "Prepared",
      actor: actorMap.get(str(header["created_by"]) ?? "") ?? null,
      at: str(header["created_at"]),
    },
    {
      event: "Allocated",
      actor: actorMap.get(str(header["allocated_by"]) ?? "") ?? null,
      at: str(header["allocated_at"]),
    },
    {
      event: "Posted",
      actor: actorMap.get(str(header["posted_by"]) ?? "") ?? null,
      at: str(header["posted_at"]),
    },
    {
      event: "Reversed",
      actor: actorMap.get(str(header["reversed_by"]) ?? "") ?? null,
      at: str(header["reversed_at"]),
    },
  ].filter((e) => Boolean(e.at));

  const status = str(header["status"]);

  const snapshot: SnapshotBlob = {
    document_type: "landed_cost_voucher",
    document_type_label: "LANDED COST VOUCHER",
    document_number: String(header["voucher_number"] ?? ""),
    status,
    // Anything not yet posted has not uplifted a single unit cost.
    is_draft: status !== "posted" && status !== "reversed",
    issue_date: voucherDate,
    posting_date: str(header["posting_date"])?.slice(0, 10) ?? null,
    shipment_reference: str(header["shipment_reference"]),
    default_basis: humanise(header["default_basis"]),
    currency,
    base_currency: baseCurrency,
    exchange_rate:
      header["exchange_rate"] === null || header["exchange_rate"] === undefined
        ? null
        : num(header["exchange_rate"]),
    exchange_rate_date: str(header["exchange_rate_date"])?.slice(0, 10) ?? null,
    total_amount: num(header["total_amount"]),
    total_base_amount: num(header["total_base_amount"]),
    capitalized_amount: num(header["capitalized_amount"]),
    expensed_amount: num(header["expensed_amount"]),
    journal_entry_number: journalMap.get(str(header["journal_entry_id"]) ?? "") ?? null,
    reversal_journal_entry_number:
      journalMap.get(str(header["reversal_journal_entry_id"]) ?? "") ?? null,
    reversal_reason: str(header["reversal_reason"]),
    notes: str(header["notes"]),
    business_name: str(business?.["name"]),
    organization_id: String(header["organization_id"]),
    business_id: (header["business_id"] as string | null) ?? null,
    branch_id: (header["branch_id"] as string | null) ?? null,
    charges,
    scope,
    allocations,
    audit_trail: auditTrail,
  };

  return {
    snapshot,
    documentNumber: String(header["voucher_number"] ?? ""),
    documentDate: voucherDate,
    organizationId: String(header["organization_id"]),
    businessId: (header["business_id"] as string | null) ?? null,
    branchId: (header["branch_id"] as string | null) ?? null,
    currency,
    sourceDocId: String(header["id"]),
    vendorId: (header["vendor_id"] as string | null) ?? null,
  };
}

export default fetchAndBuildLandedCostVoucherSnapshot;
