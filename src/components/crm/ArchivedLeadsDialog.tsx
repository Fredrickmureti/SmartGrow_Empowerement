import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArchiveRestore, Inbox } from "lucide-react";
import { useLeads, type Lead } from "@/hooks/crm";
import { useCurrency } from "@/hooks/useCurrency";
import { ReasonDialog } from "@/components/crm/ReasonDialog";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface ArchivedLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refresh the active board after a restore. */
  onRestored?: () => void;
}

/**
 * Archived opportunities are not deleted — archiving is reversible and audited
 * (`crm_archive_lead` / `crm_restore_lead`). This surface makes the archive
 * visible and restorable instead of leaving archived rows unreachable.
 */
export function ArchivedLeadsDialog({ open, onOpenChange, onRestored }: ArchivedLeadsDialogProps) {
  const { leads, isLoading, restoreLead, refreshLeads } = useLeads({ archivedOnly: true });
  const { formatCurrency, baseCurrency } = useCurrency();
  const [target, setTarget] = useState<Lead | null>(null);

  const handleRestore = async (reason: string) => {
    if (!target) return;
    try {
      await restoreLead(target.id, reason, target.version);
      setTarget(null);
      await refreshLeads();
      onRestored?.();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Could not restore this opportunity");
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Archived opportunities</DialogTitle>
            <DialogDescription>
              Archiving is reversible. Restoring returns the opportunity to its original stage and
              is recorded on the audit trail. Won and lost opportunities cannot be restored.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : leads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <Inbox className="h-8 w-8" />
              <p className="text-sm">Nothing has been archived.</p>
            </div>
          ) : (
            <div className="max-h-[420px] space-y-2 overflow-y-auto">
              {leads.map((lead) => (
                <div
                  key={lead.id}
                  className="flex items-start justify-between gap-4 rounded-lg border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{lead.lead_number}</Badge>
                      <span className="truncate font-medium">{lead.name}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(lead.expected_revenue || 0, lead.currency || baseCurrency)}
                      {lead.archived_at
                        ? ` · archived ${new Date(lead.archived_at).toLocaleDateString()}`
                        : ""}
                    </p>
                    {lead.archive_reason && (
                      <p className="text-xs italic text-muted-foreground">
                        “{lead.archive_reason}”
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!lead.won_at || !!lead.lost_at}
                    onClick={() => setTarget(lead)}
                  >
                    <ArchiveRestore className="mr-2 h-4 w-4" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={!!target}
        onOpenChange={(next) => !next && setTarget(null)}
        title="Restore opportunity"
        description={`${target?.name ?? ""} will return to the active pipeline.`}
        confirmLabel="Restore"
        onConfirm={handleRestore}
      />
    </>
  );
}
