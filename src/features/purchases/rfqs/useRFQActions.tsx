/**
 * useRFQActions — the single declaration of what you can do to an RFQ,
 * shared by the record page header and any row menu that adopts it.
 *
 * Every entry maps 1:1 to a server-side lifecycle RPC; the UI only decides
 * which transitions to *offer*, never whether they are legal — the RPC
 * re-checks state, permissions and locking.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Ban,
  CheckCircle2,
  FileText,
  GitBranch,
  Pencil,
  Send,
  Trash2,
  Upload,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useGovernanceMode } from "@/hooks/governance/useGovernanceMode";
import { useRFQs, type RFQ } from "@/hooks/useRFQs";

interface Options {
  onDeleted?: () => void;
  /** Opens the award drawer on the record page. */
  onAward?: () => void;
}

export function useRFQActions(
  rfq: RFQ | null | undefined,
  { onDeleted, onAward }: Options = {},
) {
  const navigate = useNavigate();
  const { mode: governanceMode } = useGovernanceMode();
  const {
    submitForApprovalAsync,
    approveRFQ,
    approveRFQAsync,
    releaseRFQ,
    reviseRFQ,
    convertToPurchaseOrders,
    cancelRFQ,
    deleteRFQ,
  } = useRFQs();

  return useMemo<DocumentAction[]>(() => {
    if (!rfq) return [];
    const status = rfq.status as string;
    const gated = Boolean((rfq as { approval_request_id?: string | null }).approval_request_id);
    /**
     * The award has its own governance gate (`rfq.award`). While it is open,
     * `rfq_convert_awards_to_po` refuses — so we offer the decision surface
     * instead of an action the server will reject.
     */
    const awardGated = Boolean(
      (rfq as { award_approval_request_id?: string | null }).award_approval_request_id,
    );
    const isDraft = status === "draft";
    const isLive = ["sent", "responses_received", "under_evaluation"].includes(status);

    const cancellable = [
      "draft",
      "pending_approval",
      "approved",
      "sent",
      "responses_received",
      "under_evaluation",
    ].includes(status);

    return [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        group: "core",
        primary: true,
        hidden: !isDraft,
        onSelect: () => navigate(`/purchases/rfqs/${rfq.id}/edit`),
      },
      {
        /**
         * Context aware: the server tells us whether the canonical governance
         * engine actually gated this RFQ (`gated` in the submit result). In a
         * solo / ungated tenant there is no second person to wait for, so we
         * complete the transition in one click instead of parking the RFQ in
         * `pending_approval` for the same user to approve. The server still
         * enforces everything — we only avoid a pointless extra click.
         */
        id: "submit",
        label: governanceMode === "solo" ? "Submit & approve" : "Submit for approval",
        icon: Send,
        group: "core",
        primary: isDraft,
        hidden: !isDraft,
        onSelect: async () => {
          const result = (await submitForApprovalAsync(rfq.id)) as
            | { gated?: boolean }
            | null;
          if (result && result.gated === false) {
            await approveRFQAsync(rfq.id).catch(() => undefined);
          }
        },
      },
      {
        /**
         * Approval is owned by the ONE canonical governance engine
         * (`approval_route` / `approval_decide`, configured at
         * /settings/workspace > Governance). When `approval_request_id` is
         * set the RFQ is gated: the decision must be taken in Approvals and
         * `rfq_approve` will refuse. Never add a second approval engine or a
         * module-local threshold check here.
         */
        id: "approve",
        label: gated ? "Review in Approvals" : "Approve",
        icon: CheckCircle2,
        group: "core",
        primary: status === "pending_approval",
        hidden: status !== "pending_approval",
        onSelect: () =>
          gated
            ? navigate("/settings/workspace?tab=governance")
            : approveRFQ(rfq.id),
      },

      {
        id: "release",
        label: "Release to suppliers",
        icon: Upload,
        group: "core",
        primary: status === "approved",
        hidden: status !== "approved",
        onSelect: () => releaseRFQ(rfq.id),
      },
      {
        id: "award",
        label: "Award",
        icon: CheckCircle2,
        group: "core",
        primary: status === "responses_received" || status === "under_evaluation",
        hidden: !isLive || !onAward,
        onSelect: () => onAward?.(),
      },
      {
        id: "convert",
        label: awardGated ? "Award awaiting approval" : "Convert awards to POs",
        icon: FileText,
        group: "core",
        primary: status === "awarded" || status === "partially_awarded",
        hidden: !["awarded", "partially_awarded"].includes(status),
        onSelect: () =>
          awardGated
            ? navigate("/settings/workspace?tab=governance")
            : convertToPurchaseOrders(rfq.id),
      },
      {
        id: "revise",
        label: "Revise (new version)",
        icon: GitBranch,
        hidden: !isLive && status !== "approved",
        onSelect: () => {
          const reason = window.prompt("Why is this RFQ being revised?");
          if (!reason) return;
          reviseRFQ({ id: rfq.id, reason });
        },
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: Ban,
        destructive: true,
        hidden: !cancellable,
        onSelect: () => {
          const reason = window.prompt(`Cancel RFQ ${rfq.rfq_number}? Reason:`);
          if (reason === null) return;
          cancelRFQ({ id: rfq.id, reason: reason || null });
        },
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        hidden: !isDraft,
        onSelect: () => {
          if (!window.confirm(`Delete RFQ ${rfq.rfq_number}?`)) return;
          deleteRFQ(rfq.id);
          onDeleted?.();
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq, navigate, onAward, governanceMode]);
}
