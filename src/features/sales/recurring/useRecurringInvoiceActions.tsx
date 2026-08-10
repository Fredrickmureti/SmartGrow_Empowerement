/**
 * useRecurringInvoiceActions — the single declaration of what you can do to
 * a Recurring Invoice template, rendered identically by the list row menu
 * and the record page.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Ban, Pause, Play, Trash2, Zap } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useToast } from "@/hooks/use-toast";
import {
  useRecurringInvoices,
  type RecurringInvoice,
} from "@/hooks/useRecurringInvoices";
import { canTransitionRecurring, type RecurringInvoiceStatus } from "@/lib/recurringLifecycle";
import { normalizeError } from "@/services/resilience";

interface Options {
  onChanged?: () => void;
  onDeleted?: () => void;
}

export function useRecurringInvoiceActions(
  recurring: RecurringInvoice | null | undefined,
  { onChanged, onDeleted }: Options = {},
) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { setRecurringStatus, generateInvoiceNow, deleteRecurringInvoice } = useRecurringInvoices();

  const actions = useMemo<DocumentAction[]>(() => {
    if (!recurring) return [];
    const lifecycle: RecurringInvoiceStatus =
      recurring.status ?? (recurring.is_active ? "active" : "paused");
    const canPause = canTransitionRecurring(lifecycle, "paused");
    const canActivate = canTransitionRecurring(lifecycle, "active");
    const canCancel = canTransitionRecurring(lifecycle, "cancelled");

    const run = (label: string, fn: () => Promise<unknown>) => () => {
      void (async () => {
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
        }
      })();
    };

    return [
      {
        id: "generate-now",
        label: "Generate now",
        icon: Zap,
        group: "core",
        primary: lifecycle === "active",
        disabled: lifecycle !== "active",
        disabledReason: lifecycle !== "active" ? "Only active templates can be billed" : undefined,
        onSelect: run("Invoice generated", () => generateInvoiceNow(recurring.id)),
      },
      {
        id: "pause",
        label: "Pause",
        icon: Pause,
        group: "lifecycle",
        hidden: !canPause,
        onSelect: run("Template paused", () => setRecurringStatus(recurring.id, "paused")),
      },
      {
        id: "activate",
        label: "Activate",
        icon: Play,
        group: "lifecycle",
        primary: canActivate,
        hidden: !canActivate,
        onSelect: run("Template activated", () => setRecurringStatus(recurring.id, "active")),
      },
      {
        id: "cancel",
        label: "Cancel schedule",
        icon: Ban,
        group: "lifecycle",
        destructive: true,
        hidden: !canCancel,
        onSelect: run("Schedule cancelled", () => setRecurringStatus(recurring.id, "cancelled")),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        onSelect: () =>
          void (async () => {
            try {
              await deleteRecurringInvoice(recurring.id);
              toast({ title: "Template deleted" });
              onDeleted?.();
            } catch (error: unknown) {
              toast({
                title: "Error deleting template",
                description: normalizeError(error).message,
                variant: "destructive",
              });
            }
          })(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recurring, navigate]);

  return { actions };
}
