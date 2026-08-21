/**
 * financialSnapshot.ts — the sanctioned financial reads for the AI assistant.
 *
 * WHY THIS FILE EXISTS
 * The assistant used to build its money figures from hand-written selects over
 * denormalised columns, capped at 50 rows, with every error swallowed by
 * `result.data || []`. That produced confidently wrong answers: a bank balance
 * of "0.00" (the select referenced a column that does not exist) and a
 * liabilities total that was really just the first 50 accounts by code.
 *
 * The contract here is deliberately narrow:
 *
 *   1. Every read returns a Result. A failed query is `unavailable` with a
 *      reason — NEVER a zero. Callers must render "unavailable", so the model
 *      can never be handed a fabricated number.
 *   2. Aggregates are computed over the FULL row set (paged to exhaustion),
 *      never over a `.limit()`ed page.
 *   3. Balances come from the same seams the rest of the platform uses:
 *      `bank_account_positions` for cash (ADR-0141) and `get_account_movements`
 *      (posted journal entries) for the ledger — not cached columns.
 *
 * All reads run on the caller's client, so RLS decides visibility. Nothing
 * here writes.
 */

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export function unavailable(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Wrap a supabase call so an error can never be mistaken for "no data". */
async function guarded<T>(
  label: string,
  run: () => Promise<{ data: T | null; error: { message?: string } | null }>,
): Promise<Result<T>> {
  try {
    const { data, error } = await run();
    if (error) {
      console.error(`financialSnapshot: ${label} failed`, error);
      return unavailable(error.message || "query failed");
    }
    if (data === null || data === undefined) {
      return unavailable("no data returned");
    }
    return ok(data);
  } catch (e) {
    console.error(`financialSnapshot: ${label} threw`, e);
    return unavailable(e instanceof Error ? e.message : "query failed");
  }
}

const PAGE = 1000;

/**
 * Read EVERY row of a table matching the query, paging to exhaustion.
 * Aggregates must never be built from a capped page.
 */
async function readAll<T>(
  label: string,
  build: (from: number, to: number) => Promise<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<Result<T[]>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await guarded<T[]>(label, () => build(from, from + PAGE - 1));
    if (!page.ok) return page;
    rows.push(...page.value);
    if (page.value.length < PAGE) break;
    if (rows.length > 50_000) break; // hard safety stop
  }
  return ok(rows);
}

// ─── Bank positions (cash) ─────────────────────────────────────────────────

export interface BankPositionRow {
  bank_account_id: string;
  name: string;
  bank_name: string | null;
  is_primary: boolean;
  currency: string;
  opening_balance: number;
  statement_balance: number;
  gl_balance: number | null;
  gl_shared: boolean;
  unreconciled_count: number;
  unreconciled_amount: number;
  last_statement_line_date: string | null;
  as_of: string;
}

/**
 * Cash positions per bank account via the sanctioned projection.
 * `bank_account_positions` is business-scoped, so a consolidated view asks it
 * once per business.
 */
export async function fetchBankPositions(
  client: any,
  businessIds: string[],
  asOf: string,
): Promise<Result<BankPositionRow[]>> {
  if (businessIds.length === 0) return unavailable("no business in scope");

  const accounts = await readAll<any>("bank_accounts", (from, to) =>
    client
      .from("bank_accounts")
      .select("id, name, bank_name, currency, is_primary, business_id, is_active")
      .in("business_id", businessIds)
      .eq("is_active", true)
      .range(from, to));
  if (!accounts.ok) return accounts;

  const meta = new Map<string, any>();
  for (const a of accounts.value) meta.set(a.id, a);

  const rows: BankPositionRow[] = [];
  for (const businessId of businessIds) {
    const pos = await guarded<any[]>("bank_account_positions", () =>
      client.rpc("bank_account_positions", { _business_id: businessId, _as_of: asOf }));
    if (!pos.ok) return pos;
    for (const p of pos.value) {
      const m = meta.get(p.bank_account_id);
      if (!m) continue;
      rows.push({
        bank_account_id: p.bank_account_id,
        name: m.name,
        bank_name: m.bank_name ?? null,
        is_primary: !!m.is_primary,
        currency: p.currency || m.currency,
        opening_balance: Number(p.opening_balance) || 0,
        statement_balance: Number(p.statement_balance) || 0,
        gl_balance: p.gl_balance === null || p.gl_balance === undefined ? null : Number(p.gl_balance),
        gl_shared: !!p.gl_shared,
        unreconciled_count: Number(p.unreconciled_count) || 0,
        unreconciled_amount: Number(p.unreconciled_amount) || 0,
        last_statement_line_date: p.last_statement_line_date ?? null,
        as_of: p.as_of,
      });
    }
  }
  return ok(rows);
}

// ─── Ledger balances (posted journal entries) ──────────────────────────────

export interface LedgerBalances {
  /** Signed by the account type's normal side: assets/expenses debit-positive,
   *  liabilities/equity/income credit-positive. */
  byType: Record<string, number>;
  revenue: number;
  expenses: number;
  accountCount: number;
  dateFrom: string;
  dateTo: string;
}

const LEDGER_EPOCH = "1900-01-01";

/**
 * Balances by account type derived from POSTED journal entries — the same seam
 * `src/services/gl/fetchGLTotals.ts` uses, so the assistant and the financial
 * reports can never disagree.
 */
export async function fetchLedgerBalances(
  client: any,
  organizationId: string,
  businessId: string | null,
  branchId: string | null,
  periodFrom: string,
  periodTo: string,
): Promise<Result<LedgerBalances>> {
  const accounts = await readAll<any>("accounts", (from, to) =>
    client
      .from("accounts")
      .select("id, account_type")
      .eq("organization_id", organizationId)
      .range(from, to));
  if (!accounts.ok) return accounts;

  const typeOf = new Map<string, string>();
  for (const a of accounts.value) typeOf.set(a.id, a.account_type);

  const all = await guarded<any[]>("get_account_movements (all time)", () =>
    client.rpc("get_account_movements", {
      _org_id: organizationId,
      _date_from: LEDGER_EPOCH,
      _date_to: periodTo,
      _business_id: businessId,
      _branch_id: branchId,
    }));
  if (!all.ok) return all;

  const period = await guarded<any[]>("get_account_movements (period)", () =>
    client.rpc("get_account_movements", {
      _org_id: organizationId,
      _date_from: periodFrom,
      _date_to: periodTo,
      _business_id: businessId,
      _branch_id: branchId,
    }));
  if (!period.ok) return period;

  const byType: Record<string, number> = {};
  for (const m of all.value) {
    const type = typeOf.get(m.account_id);
    if (!type) continue;
    const debit = Number(m.total_debit) || 0;
    const credit = Number(m.total_credit) || 0;
    const signed = type === "asset" || type === "expense" ? debit - credit : credit - debit;
    byType[type] = (byType[type] || 0) + signed;
  }

  let revenue = 0;
  let expenses = 0;
  for (const m of period.value) {
    const type = typeOf.get(m.account_id);
    const debit = Number(m.total_debit) || 0;
    const credit = Number(m.total_credit) || 0;
    if (type === "income") revenue += credit - debit;
    else if (type === "expense") expenses += debit - credit;
  }

  return ok({
    byType,
    revenue,
    expenses,
    accountCount: accounts.value.length,
    dateFrom: periodFrom,
    dateTo: periodTo,
  });
}

// ─── Open items (AR / AP subledgers) ───────────────────────────────────────

export interface OpenItemsTotal {
  residual: number;
  overdue: number;
  documentCount: number;
}

/** Receivables from the `finance_ar_open_items` projection — the only
 *  sanctioned source (credit notes and allocations already netted). */
export async function fetchReceivables(
  client: any,
  organizationId: string,
  businessId: string | null,
  today: string,
): Promise<Result<OpenItemsTotal>> {
  const rows = await readAll<any>("finance_ar_open_items", (from, to) => {
    let q = client
      .from("finance_ar_open_items")
      .select("residual_amount, base_residual_amount, due_date")
      .eq("organization_id", organizationId)
      .range(from, to);
    if (businessId) q = q.eq("business_id", businessId);
    return q;
  });
  if (!rows.ok) return rows;

  let residual = 0;
  let overdue = 0;
  for (const r of rows.value) {
    const amount = Number(r.base_residual_amount ?? r.residual_amount) || 0;
    residual += amount;
    if (r.due_date && r.due_date < today) overdue += amount;
  }
  return ok({ residual, overdue, documentCount: rows.value.length });
}

/**
 * Payables. There is no `finance_ap_open_items` projection in this database,
 * so the residual is computed from the bill subledger the same way the AR
 * projection does it: bill total less payment allocations less applied vendor
 * credit notes, excluding terminal documents.
 */
export async function fetchPayables(
  client: any,
  organizationId: string,
  businessId: string | null,
  today: string,
): Promise<Result<OpenItemsTotal>> {
  const TERMINAL = ["paid", "void", "voided", "cancelled", "draft"];

  const bills = await readAll<any>("bills", (from, to) => {
    let q = client
      .from("bills")
      .select("id, total, due_date, status, voided_at")
      .eq("organization_id", organizationId)
      .range(from, to);
    if (businessId) q = q.eq("business_id", businessId);
    return q;
  });
  if (!bills.ok) return bills;

  const open = bills.value.filter(
    (b: any) => !b.voided_at && !TERMINAL.includes(String(b.status || "").toLowerCase()),
  );
  if (open.length === 0) return ok({ residual: 0, overdue: 0, documentCount: 0 });

  const ids = new Set(open.map((b: any) => b.id));

  const allocations = await readAll<any>("bill_payment_allocations", (from, to) => {
    let q = client
      .from("bill_payment_allocations")
      .select("bill_id, amount")
      .eq("organization_id", organizationId)
      .range(from, to);
    if (businessId) q = q.eq("business_id", businessId);
    return q;
  });
  if (!allocations.ok) return allocations;

  const credits = await readAll<any>("vendor_credit_note_applications", (from, to) => {
    let q = client
      .from("vendor_credit_note_applications")
      .select("bill_id, amount, reversed_at")
      .eq("organization_id", organizationId)
      .range(from, to);
    if (businessId) q = q.eq("business_id", businessId);
    return q;
  });
  if (!credits.ok) return credits;

  const applied = new Map<string, number>();
  for (const a of allocations.value) {
    if (!ids.has(a.bill_id)) continue;
    applied.set(a.bill_id, (applied.get(a.bill_id) || 0) + (Number(a.amount) || 0));
  }
  for (const c of credits.value) {
    if (!ids.has(c.bill_id) || c.reversed_at) continue;
    applied.set(c.bill_id, (applied.get(c.bill_id) || 0) + (Number(c.amount) || 0));
  }

  let residual = 0;
  let overdue = 0;
  let documentCount = 0;
  for (const b of open) {
    const left = (Number(b.total) || 0) - (applied.get(b.id) || 0);
    if (left <= 0.005) continue;
    residual += left;
    documentCount += 1;
    if (b.due_date && b.due_date < today) overdue += left;
  }
  return ok({ residual, overdue, documentCount });
}

// ─── Rendering helpers ─────────────────────────────────────────────────────

/**
 * Render a Result for the prompt. An unavailable read is stated as such — the
 * model is told it may not quote a figure for it.
 */
export function renderResult<T>(
  result: Result<T>,
  render: (value: T) => string,
): string {
  if (!result.ok) {
    return `unavailable — the underlying query failed (${result.reason}). ` +
      `Do NOT state a figure for this; say the data could not be read.`;
  }
  return render(result.value);
}
