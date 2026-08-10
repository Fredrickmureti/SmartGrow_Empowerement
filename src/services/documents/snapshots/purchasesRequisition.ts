/**
 * Purchase Requisition snapshot builder
 * (`document_kinds.code = 'purchases.requisition'`).
 *
 * WHAT A REQUISITION IS
 * ---------------------
 * An INTERNAL demand record: someone inside the organisation states that
 * a quantity of something is needed, by when, charged to which cost
 * centre, and asks for approval. It is not addressed to anybody outside
 * the business, and it is never a commercial commitment — the commitment
 * is the purchase order that may later be raised from it.
 *
 * Consequences for this snapshot:
 *   - No supplier / contact block. There is no counterparty.
 *   - No prices, no totals. `estimated_unit_price` and `estimated_total`
 *     are internal budgeting figures used for approval routing; printing
 *     them as a document ladder would misrepresent an estimate as a
 *     payable amount. The document carries QUANTITIES.
 *   - The kind is registered WITHOUT an `email` intent, so this snapshot
 *     can never be dispatched to a supplier.
 *
 * Quantities are server-owned: `quantity_ordered` / `quantity_cancelled`
 * are maintained by `_pr_recalc`. `quantity_outstanding` is frozen here
 * using the same rule the database applies (qty − ordered − short-closed,
 * floored at zero per line) so the printed sheet agrees with the
 * workbench — the layout never recomputes demand.
 *
 * Paired layout: `_shared/pdf/layouts/procurement.ts::generateRequisitionPdf`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface PurchasesRequisitionItemRow {
  description: string | null;
  quantity: number | null;
  quantity_ordered?: number | null;
  quantity_cancelled?: number | null;
  quantity_received?: number | null;
  need_by_date?: string | null;
  sort_order?: number | null;
  product?: { sku: string | null } | null;
  uom?: { code: string | null } | null;
}

export interface PurchasesRequisitionApprovalRow {
  step_order: number | null;
  actor_user_id: string | null;
  decision: string | null;
  comment: string | null;
  created_at: string | null;
}

export interface PurchasesRequisitionHeaderRow {
  id: string;
  requisition_number: string;
  status: string;
  version?: number | null;
  created_at: string;
  submitted_at: string | null;
  need_by_date: string | null;
  cost_center: string | null;
  justification: string | null;
  notes: string | null;
  priority?: string | null;
  currency: string | null;
  requester_id: string | null;
  project_id: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  business?: { name?: string | null; base_currency?: string | null } | null;
  analytic?: { name?: string | null } | null;
  items?: PurchasesRequisitionItemRow[] | null;
  approvals?: PurchasesRequisitionApprovalRow[] | null;
}

export interface BuildPurchasesRequisitionSnapshotOptions {
  requesterName?: string | null;
  projectName?: string | null;
  destination?: string | null;
  /** userId → display name, for the approval trail. */
  actorNames?: Map<string, string>;
}

export interface BuildPurchasesRequisitionSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  revision: number;
}

export function buildPurchasesRequisitionSnapshot(
  req: PurchasesRequisitionHeaderRow,
  options: BuildPurchasesRequisitionSnapshotOptions = {},
): BuildPurchasesRequisitionSnapshotResult {
  if (!req.id) throw new Error("buildPurchasesRequisitionSnapshot: id required");
  if (!req.requisition_number) {
    throw new Error("buildPurchasesRequisitionSnapshot: requisition_number required");
  }

  const issueDate = (req.submitted_at ?? req.created_at).slice(0, 10);
  const revision = Number(req.version ?? 1);
  const currency = req.currency || req.business?.base_currency || "USD";
  const actorNames = options.actorNames ?? new Map<string, string>();

  const items = [...(req.items ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((item) => {
      const qty = Number(item.quantity ?? 0);
      const ordered = Number(item.quantity_ordered ?? 0);
      const cancelled = Number(item.quantity_cancelled ?? 0);
      return {
        description: item.description ?? null,
        quantity: qty,
        quantity_ordered: ordered,
        quantity_cancelled: cancelled,
        quantity_received: Number(item.quantity_received ?? 0),
        // Mirrors `_pr_recalc`; see the file header.
        quantity_outstanding: Math.max(0, qty - ordered - cancelled),
        sku: item.product?.sku ?? null,
        unit_of_measure: item.uom?.code ?? null,
        need_by_date: item.need_by_date ?? null,
      };
    });

  const approvals = [...(req.approvals ?? [])]
    .sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))
    .map((a) => ({
      step: a.step_order ?? null,
      approver_name: a.actor_user_id ? (actorNames.get(a.actor_user_id) ?? null) : null,
      decision: a.decision ?? null,
      comment: a.comment ?? null,
      decided_at: a.created_at ?? null,
    }));

  const snapshot: SnapshotBlob = {
    document_type: "purchase_requisition",
    document_type_label: "PURCHASE REQUISITION",
    document_number: req.requisition_number,
    revision,
    status: req.status,
    priority: req.priority ?? null,
    issue_date: issueDate,
    need_by_date: req.need_by_date ? req.need_by_date.slice(0, 10) : null,
    requester_name: options.requesterName ?? null,
    cost_center: req.cost_center ?? null,
    analytic_account_name: req.analytic?.name ?? null,
    project_name: options.projectName ?? null,
    destination: options.destination ?? null,
    justification: req.justification ?? null,
    notes: req.notes ?? null,
    // Retained for approval-routing context only; never rendered as money.
    currency,
    business_name: req.business?.name ?? null,
    business_id: req.business_id,
    organization_id: req.organization_id,
    branch_id: req.branch_id,
    items,
    approvals,
  };

  return {
    snapshot,
    documentNumber: revision > 1
      ? `${req.requisition_number}-R${revision}`
      : req.requisition_number,
    documentDate: issueDate,
    organizationId: req.organization_id,
    businessId: req.business_id,
    branchId: req.branch_id,
    currency,
    sourceDocId: req.id,
    revision,
  };
}

/**
 * `requester_id` / `actor_user_id` reference `auth.users`, so there is no
 * embeddable FK — the same follow-up hydration the workbench does.
 * Likewise `project_id` and the destination ids carry no declared FK, so
 * they are resolved in a second round-trip rather than embedded.
 */
export async function fetchAndBuildPurchasesRequisitionSnapshot(
  supabase: SupabaseClient,
  requisitionId: string,
): Promise<BuildPurchasesRequisitionSnapshotResult> {
  const client = supabase as unknown as SupabaseClient<never>;
  const { data, error } = await (client as any)
    .from("purchase_requisitions")
    .select(
      `
      id, requisition_number, status, version, created_at, submitted_at,
      need_by_date, cost_center, justification, notes, priority, currency,
      requester_id, project_id, destination_branch_id, destination_warehouse_id,
      organization_id, business_id, branch_id,
      business:businesses(name, base_currency),
      analytic:analytic_accounts!analytic_account_id(name),
      items:purchase_requisition_items(
        description, quantity, quantity_ordered, quantity_cancelled,
        quantity_received, need_by_date, sort_order,
        product:products(sku),
        uom:units_of_measure!uom_id(code)
      ),
      approvals:purchase_requisition_approvals(
        step_order, actor_user_id, decision, comment, created_at
      )
      `,
    )
    .eq("id", requisitionId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchAndBuildPurchasesRequisitionSnapshot: requisition ${requisitionId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const row = data as Record<string, unknown>;

  // Actor / requester display names.
  const userIds = Array.from(
    new Set(
      [
        row["requester_id"] as string | null,
        ...(((row["approvals"] as PurchasesRequisitionApprovalRow[] | null) ?? []).map(
          (a) => a.actor_user_id,
        )),
      ].filter((v): v is string => Boolean(v)),
    ),
  );
  const actorNames = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await (client as any)
      .from("profiles")
      .select("id, full_name, email")
      .in("id", userIds);
    for (const p of (profiles ?? []) as Array<Record<string, unknown>>) {
      const name = (p["full_name"] as string) || (p["email"] as string) || "";
      if (name) actorNames.set(p["id"] as string, name);
    }
  }

  // Project name.
  let projectName: string | null = null;
  if (row["project_id"]) {
    const { data: project } = await (client as any)
      .from("projects")
      .select("name")
      .eq("id", row["project_id"] as string)
      .maybeSingle();
    projectName = (project?.name as string) ?? null;
  }

  // Destination — warehouse wins over branch (it is the more specific
  // delivery point when both are set).
  let destination: string | null = null;
  if (row["destination_warehouse_id"]) {
    const { data: wh } = await (client as any)
      .from("warehouses")
      .select("name")
      .eq("id", row["destination_warehouse_id"] as string)
      .maybeSingle();
    destination = (wh?.name as string) ?? null;
  }
  if (!destination && row["destination_branch_id"]) {
    const { data: br } = await (client as any)
      .from("branches")
      .select("name")
      .eq("id", row["destination_branch_id"] as string)
      .maybeSingle();
    destination = (br?.name as string) ?? null;
  }

  return buildPurchasesRequisitionSnapshot(
    data as unknown as PurchasesRequisitionHeaderRow,
    {
      requesterName: row["requester_id"]
        ? (actorNames.get(row["requester_id"] as string) ?? null)
        : null,
      projectName,
      destination,
      actorNames,
    },
  );
}
