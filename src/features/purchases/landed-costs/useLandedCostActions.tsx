/**
 * useLandedCostActions — the single action vocabulary of a Landed Cost
 * Voucher, shared by the record page header, the list row menu and the peek.
 *
 * Every transition is a server command (`landedCostRpcs`). The browser never
 * writes `status`, `capitalized_amount`, a cost layer or a journal line:
 *
 *   draft      → Allocate            (spreads charges over receipt lines)
 *   allocated  → Post                (writes GL + uplifts inventory cost)
 *              → Allocate again      (idempotent re-spread while unposted)
 *   posted     → Reverse             (reason required; restores unit costs)
 *   draft      → Delete              (the only hard delete the server allows)
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Calculator,
  BookCheck,
  RotateCcw,
  Trash2,
  FileSearch,
  Printer,
  Download,
} from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { supabase } from "@/integrations/supabase/client";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/purchases/record/useRecordPrint";
import { useRecordDownload } from "@/features/purchases/record/useRecordDownload";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  allocateLandedCostVoucher,
  postLandedCostVoucher,
  reverseLandedCostVoucher,
} from "./landedCostRpcs";
import type { LandedCostRecord } from "./useLandedCosts";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

type PromptKind = "reverse" | "delete" | null;

export function useLandedCostActions(
  record: LandedCostRecord | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  // Output disposition. Preview / Print / Download render the SAME frozen
  // snapshot through the one document pipeline; a landed cost voucher is
  // internal costing evidence, so there is deliberately no Email verb.
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("landed_cost_voucher");
  const { download, downloading } = useRecordDownload("landed_cost_voucher");
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const voucher = record?.voucher ?? null;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: label });
      onChanged?.();
    } catch (error: unknown) {
      toast({
        title: "Action failed",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const actions = useMemo<DocumentAction[]>(() => {
    if (!voucher) return [];
    const status = String(voucher.status);
    const voucherLabel = voucher.voucher_number ?? voucher.id.slice(0, 8);
    const componentCount = record?.components.length ?? 0;
    const scopeCount = record?.scope.length ?? 0;
    const chargeTotal = (record?.components ?? []).reduce(
      (sum, c) => sum + Number(c.amount ?? 0),
      0,
    );

    const guarded = (fn: () => void) => () => {
      if (isReadOnly) {
        openUpgradeModal("landed_costs");
        return;
      }
      fn();
    };

    const canAllocate = status === "draft" || status === "allocated";
    const allocateBlock =
      scopeCount === 0
        ? "Add at least one goods receipt to the shipment scope first."
        : componentCount === 0
          ? "Capture at least one charge line first."
          : chargeTotal <= 0
            ? "Charges must total more than zero."
            : undefined;

    return [
      {
        id: "allocate",
        label: status === "allocated" ? "Re-allocate" : "Allocate",
        icon: Calculator,
        group: "lifecycle",
        primary: status !== "allocated",
        hidden: !canAllocate,
        disabled: busy || !!allocateBlock,
        disabledReason: allocateBlock,
        onSelect: guarded(() =>
          void run("Charges allocated", () => allocateLandedCostVoucher(voucher.id)),
        ),
      },
      {
        id: "post",
        label: "Post to ledger",
        icon: BookCheck,
        group: "lifecycle",
        primary: true,
        hidden: status !== "allocated",
        disabled: busy,
        onSelect: guarded(() =>
          void (async () => {
            setBusy(true);
            try {
              const result = await postLandedCostVoucher(voucher.id);
              toast({
                title:
                  (result as { gated?: boolean } | null)?.gated
                    ? "Sent for approval"
                    : "Voucher posted",
                description: (result as { gated?: boolean } | null)?.gated
                  ? "Your approval policy gates landed cost postings. The voucher posts automatically once it is approved."
                  : undefined,
              });
              onChanged?.();
            } catch (error: unknown) {
              toast({
                title: "Action failed",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            } finally {
              setBusy(false);
            }
          })(),
        ),
      },
      {
        id: "awaiting-approval",
        label: "Awaiting approval",
        icon: BookCheck,
        group: "lifecycle",
        hidden: status !== "pending_approval",
        disabled: true,
        disabledReason:
          "This voucher is with its approvers. It posts to the ledger automatically once approved.",
        onSelect: () => {},
      },

      {
        id: "reverse",
        label: "Reverse posting",
        icon: RotateCcw,
        group: "lifecycle",
        destructive: true,
        hidden: status !== "posted",
        disabled: busy,
        onSelect: guarded(() => {
          setReason("");
          setPrompt("reverse");
        }),
      },
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "landed_cost_voucher",
            documentId: voucher.id,
            title: `Landed cost ${voucherLabel}`,
            filename: `landed-cost-${voucherLabel}`,
          }),
      },
      {
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(voucher.id, `Landed cost ${voucherLabel}`),
      },
      {
        id: "download",
        label: downloading ? "Preparing…" : "Download PDF",
        icon: Download,
        group: "output",
        disabled: downloading,
        onSelect: () => void download(voucher.id, `landed-cost-${voucherLabel}`),
      },
      {
        id: "delete",
        label: "Delete voucher",
        icon: Trash2,
        group: "danger",
        destructive: true,
        hidden: status !== "draft",
        disabled: busy,
        onSelect: guarded(() => setPrompt("delete")),
      },
    ];
    // `run` is recreated each render by design; the deps below are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    voucher,
    record,
    busy,
    isReadOnly,
    openUpgradeModal,
    preview,
    print,
    printing,
    download,
    downloading,
  ]);

  const dialogs = (
    <>
      <AlertDialog
        open={prompt === "reverse"}
        onOpenChange={(open) => !open && setPrompt(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse this landed cost posting?</AlertDialogTitle>
            <AlertDialogDescription>
              The server writes a reversing journal entry and restores the unit
              costs this voucher uplifted. Stock already consumed is unwound
              through cost of sales.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="lc-reversal-reason">Reason</Label>
            <Input
              id="lc-reversal-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Freight invoice restated by the carrier"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!reason.trim() || busy}
              onClick={() => {
                if (!voucher) return;
                setPrompt(null);
                void run("Voucher reversed", () =>
                  reverseLandedCostVoucher(voucher.id, reason),
                );
              }}
            >
              Reverse
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={prompt === "delete"}
        onOpenChange={(open) => !open && setPrompt(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft voucher?</AlertDialogTitle>
            <AlertDialogDescription>
              Draft vouchers have never touched the ledger or inventory, so the
              row is removed outright. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!voucher) return;
                setPrompt(null);
                void (async () => {
                  setBusy(true);
                  const { error } = await supabase
                    .from("landed_cost_vouchers")
                    .delete()
                    .eq("id", voucher.id);
                  setBusy(false);
                  if (error) {
                    toast({
                      title: "Delete failed",
                      description: error.message,
                      variant: "destructive",
                    });
                    return;
                  }
                  toast({ title: "Draft voucher deleted" });
                  if (onDeleted) onDeleted();
                  else navigate("/purchases/landed-costs");
                })();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { actions, dialogs, busy };
}
