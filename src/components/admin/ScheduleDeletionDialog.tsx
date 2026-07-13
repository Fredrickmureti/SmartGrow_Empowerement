// @ts-nocheck - Admin RPCs not in auto-generated types
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, AlertTriangle, Clock, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

/**
 * Schedule a tenant for permanent deletion after a configurable grace window.
 * Mirrors how Odoo / QuickBooks / Xero handle account closure: the account is
 * suspended immediately, but data is retained for the grace period so the
 * tenant can export or request a reactivation. After the window elapses, the
 * cron job calls `process_scheduled_organization_deletions` and the org is
 * permanently purged.
 *
 * If the org is already scheduled for deletion, this dialog switches to a
 * cancellation flow (one click to clear the schedule).
 */
interface ScheduleDeletionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization:
    | {
        id: string;
        name: string;
        scheduled_deletion_at?: string | null;
        deletion_grace_days?: number | null;
      }
    | null;
  onSuccess: () => void;
}

const PRESET_DAYS = [7, 15, 30, 90];

export function ScheduleDeletionDialog({
  open,
  onOpenChange,
  organization,
  onSuccess,
}: ScheduleDeletionDialogProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [graceDays, setGraceDays] = useState<number>(15);
  const [reason, setReason] = useState("");

  if (!organization) return null;
  const isScheduled = !!organization.scheduled_deletion_at;

  const handleSchedule = async () => {
    if (graceDays < 0 || graceDays > 365) {
      toast({
        title: "Invalid grace period",
        description: "Grace must be between 0 and 365 days.",
        variant: "destructive",
      });
      return;
    }
    setIsSaving(true);
    try {
      const { data, error } = await (supabase as any).rpc(
        "schedule_organization_deletion",
        {
          p_org_id: organization.id,
          p_grace_days: graceDays,
          p_reason: reason.trim() || null,
        },
      );
      if (error) throw error;
      toast({
        title: "Deletion scheduled",
        description: `${organization.name} will be permanently deleted on ${format(new Date(data.scheduled_deletion_at), "PPP")}.`,
      });
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({
        title: "Could not schedule deletion",
        description: normalizeError(e).message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = async () => {
    setIsSaving(true);
    try {
      const { error } = await (supabase as any).rpc(
        "cancel_scheduled_organization_deletion",
        { p_org_id: organization.id },
      );
      if (error) throw error;
      toast({
        title: "Scheduled deletion cancelled",
        description: `${organization.name} will not be deleted. Suspension state is unchanged — lift it from the Suspend dialog if needed.`,
      });
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({
        title: "Could not cancel",
        description: normalizeError(e).message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
            {isScheduled ? (
              <RotateCcw className="h-6 w-6 text-amber-600" />
            ) : (
              <Clock className="h-6 w-6 text-amber-600" />
            )}
          </div>
          <AlertDialogTitle className="text-center">
            {isScheduled
              ? "Cancel scheduled deletion"
              : "Schedule deletion"}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-center">
            {isScheduled ? (
              <>
                <strong>{organization.name}</strong> is currently scheduled
                for deletion on{" "}
                <strong>
                  {format(new Date(organization.scheduled_deletion_at!), "PPP")}
                </strong>
                . You can cancel and retain the data.
              </>
            ) : (
              <>
                Suspend <strong>{organization.name}</strong> immediately and
                queue it for permanent deletion after a grace window. The
                tenant will lose write access right away. Data is retained
                until the window elapses, then purged automatically.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!isScheduled && (
          <div className="space-y-4 py-2">
            <div>
              <Label>Grace period (days)</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {PRESET_DAYS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    size="sm"
                    variant={graceDays === d ? "default" : "outline"}
                    onClick={() => setGraceDays(d)}
                  >
                    {d} days
                  </Button>
                ))}
                <Input
                  type="number"
                  min={0}
                  max={365}
                  className="w-24"
                  value={graceDays}
                  onChange={(e) => setGraceDays(Number(e.target.value))}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Set 0 for immediate purge (use sparingly — bypasses the
                tenant-export window).
              </p>
            </div>

            <div>
              <Label htmlFor="reason">Reason (audit log)</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Customer requested account closure / migrating to another platform"
                rows={3}
              />
            </div>

            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                The tenant will be suspended immediately. After the grace
                period, the daily cron will permanently purge all data,
                files, and audit trails for this organization.
              </span>
            </div>
          </div>
        )}

        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            disabled={isSaving}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          {isScheduled ? (
            <Button
              variant="default"
              disabled={isSaving}
              onClick={handleCancel}
            >
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Cancel scheduled deletion
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={isSaving}
              onClick={handleSchedule}
            >
              {isSaving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Clock className="mr-2 h-4 w-4" />
              )}
              Schedule deletion in {graceDays} days
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
