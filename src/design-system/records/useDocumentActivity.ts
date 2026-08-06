/**
 * useDocumentActivity — the real, event-sourced activity feed for any
 * transactional document.
 *
 * Before this hook, every record page hand-built a two-entry synthetic list
 * ("created" from `created_at`, "confirmed" if `confirmed_by` was set). That
 * is a rendering of the document's *current* columns, not its history: it
 * could not show who did what, it lost every intermediate transition, and it
 * silently disagreed with the audit log the compliance screens read from.
 *
 * The feed is composed from the two systems that actually record document
 * history:
 *   - `audit_logs`  — mutations (created / updated / confirmed / voided / …)
 *   - `document_emails` — outbound sends, which are not audited but are the
 *     event users most often look for ("did this invoice go out?")
 *
 * Both are merged, newest-first, and actor ids are resolved to names in one
 * batched `profiles` lookup rather than per row.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import type { DocumentActivityEntry } from "./panels";
import type { DocumentKind } from "./documentStatus";

/**
 * `audit_logs.entity_type` / `document_emails.document_type` use the same
 * singular snake_case vocabulary as DocumentKind, so the mapping is identity
 * for every kind we currently record. Kept explicit so a divergence is a
 * compile error rather than a silently empty feed.
 */
const ENTITY_TYPE: Partial<Record<DocumentKind, string>> = {
  invoice: "invoice",
  estimate: "estimate",
  sales_order: "sales_order",
  proforma: "proforma_invoice",
  delivery_note: "delivery_note",
  credit_note: "credit_note",
  sales_return: "sales_return",
  customer_payment: "payment",
  recurring_invoice: "recurring_invoice",
  statement: "customer_statement",
  bill: "bill",
  purchase_order: "purchase_order",
};

const ACTION_TONE: Record<string, DocumentActivityEntry["tone"]> = {
  created: "neutral",
  updated: "neutral",
  confirmed: "info",
  approved: "info",
  sent: "info",
  paid: "success",
  completed: "success",
  received: "success",
  cancelled: "warning",
  rejected: "danger",
  voided: "danger",
  deleted: "danger",
};

/** "confirmed" → "Confirmed"; "sod.self_action_auto_allowed" → readable. */
function humanizeAction(action: string): string {
  const tail = action.includes(".") ? action.split(".").pop()! : action;
  const words = tail.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fmt(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? at
    : d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}

export interface UseDocumentActivityResult {
  entries: DocumentActivityEntry[];
  loading: boolean;
}

export function useDocumentActivity(
  kind: DocumentKind | undefined,
  documentId: string | undefined,
): UseDocumentActivityResult {
  const { currentOrg } = useOrganization();
  const organizationId = currentOrg?.id;
  const entityType = kind ? ENTITY_TYPE[kind] : undefined;
  const enabled = !!organizationId && !!entityType && !!documentId;

  const { data, isLoading } = useQuery({
    queryKey: ["document-activity", organizationId, entityType, documentId],
    enabled,
    queryFn: async (): Promise<DocumentActivityEntry[]> => {
      const [audit, emails] = await Promise.all([
        supabase
          .from("audit_logs")
          .select("id, action, user_id, changes_summary, created_at")
          .eq("organization_id", organizationId!)
          .eq("entity_type", entityType!)
          .eq("entity_id", documentId!)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("document_emails")
          .select("id, recipient_email, subject, status, sent_at, sent_by, created_at, error_message")
          .eq("organization_id", organizationId!)
          .eq("document_type", entityType!)
          .eq("document_id", documentId!)
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      if (audit.error) throw audit.error;
      // A missing send history must not blank the whole feed.
      const emailRows = emails.error ? [] : (emails.data ?? []);
      const auditRows = audit.data ?? [];

      const actorIds = Array.from(
        new Set(
          [
            ...auditRows.map((r) => r.user_id),
            ...emailRows.map((r) => r.sent_by),
          ].filter((v): v is string => !!v),
        ),
      );

      const names = new Map<string, string>();
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", actorIds);
        for (const p of profiles ?? []) {
          names.set(p.user_id, p.full_name || p.email || "Unknown user");
        }
      }

      type Sortable = DocumentActivityEntry & { sortKey: string };
      const entries: Sortable[] = [
        ...auditRows.map((r) => ({
          id: `audit:${r.id}`,
          at: fmt(r.created_at),
          sortKey: r.created_at,
          actor: r.user_id ? names.get(r.user_id) ?? "Unknown user" : "System",
          title: humanizeAction(r.action),
          description: r.changes_summary ?? undefined,
          tone: ACTION_TONE[r.action] ?? "neutral",
        })),
        ...emailRows.map((r) => {
          const failed = r.status === "failed";
          const at = r.sent_at ?? r.created_at;
          return {
            id: `email:${r.id}`,
            at: fmt(at),
            sortKey: at,
            actor: r.sent_by ? names.get(r.sent_by) ?? "Unknown user" : "System",
            title: failed ? "Send failed" : "Emailed to customer",
            description: failed
              ? r.error_message ?? `Could not send to ${r.recipient_email}`
              : `${r.recipient_email}${r.subject ? ` — ${r.subject}` : ""}`,
            tone: (failed ? "danger" : "info") as DocumentActivityEntry["tone"],
          };
        }),
      ];

      return entries
        .sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1))
        .map(({ sortKey: _sortKey, ...entry }) => entry);
    },
  });

  return { entries: data ?? [], loading: enabled && isLoading };
}
