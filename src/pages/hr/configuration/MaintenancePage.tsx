import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Wrench, Link as LinkIcon, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { ConfigPageHeader } from "./_ConfigShell";

/**
 * Bulk auto-link uses the server-side `get_linkable_users_for_employee`
 * RPC (Wave H F4) and the `employees_active` view so that draft /
 * abandoned employee records never leak into operational sweeps.
 *
 * Stale drafts are surfaced as their own operational debt card so HR
 * can see and discard them — they used to silently inflate counts
 * across the HR product.
 */
export default function MaintenancePage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [running, setRunning] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [staleDrafts, setStaleDrafts] = useState<number | null>(null);

  const refreshStaleCount = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    const { data, error } = await (supabase as any).rpc("count_stale_employee_drafts", {
      p_business_id: currentBusiness.id,
      p_organization_id: currentOrg.id,
      p_max_age_hours: 24,
    });
    if (!error) setStaleDrafts(typeof data === "number" ? data : Number(data ?? 0));
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    void refreshStaleCount();
  }, [refreshStaleCount]);

  const autoLink = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setRunning(true);
    try {
      // employees_active view filters out draft/archived rows so
      // abandoned creation attempts no longer inflate this sweep.
      const { data: unlinked, error } = await (supabase as any)
        .from("employees_active")
        .select("id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .is("user_id", null);
      if (error) throw error;
      if (!unlinked?.length) {
        toast.info("No unlinked active employees");
        return;
      }

      let linked = 0;
      const blockedReasons = new Map<string, number>();
      let alreadyLinked = 0;
      let eligibleSeen = 0;
      const checked = unlinked.length;

      for (const emp of unlinked) {
        const { data: candidates, error: cErr } = await supabase
          .rpc("get_linkable_users_for_employee" as any, {
            p_org_id: currentOrg.id,
            p_employee_id: emp.id,
          });
        if (cErr) continue;
        const list = (candidates as any[] | null) ?? [];
        const eligible = list.find((c) => c?.linkability === "eligible");
        if (eligible?.user_id) {
          eligibleSeen++;
          const { error: linkErr } = await supabase.rpc("link_employee_to_user" as any, {
            p_employee_id: emp.id,
            p_user_id: eligible.user_id,
            p_force: false,
          });
          if (!linkErr) linked++;
          continue;
        }
        // Aggregate skip reasons so the operator sees *why* nobody linked.
        for (const c of list) {
          if (c?.linkability === "already_linked") alreadyLinked++;
          else if (c?.linkability === "blocked" && c?.block_reason) {
            blockedReasons.set(c.block_reason, (blockedReasons.get(c.block_reason) ?? 0) + 1);
          }
        }
      }

      if (linked > 0) {
        toast.success(`Linked ${linked} of ${checked} active employee(s)`);
      } else {
        const reasonSummary =
          [...blockedReasons.entries()]
            .map(([reason, n]) => `${n}× ${reason}`)
            .join("; ") ||
          (alreadyLinked > 0 ? `${alreadyLinked}× already linked elsewhere` : "no candidate workspace members");
        toast.info(
          `Checked ${checked} active employee(s); 0 eligible matches. Skipped: ${reasonSummary}.`,
        );
      }
    } catch (err: any) {
      toast.error(err?.message || "Auto-link failed");
    } finally {
      setRunning(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  const discardDrafts = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setDiscarding(true);
    try {
      const { data, error } = await (supabase as any).rpc("discard_stale_employee_drafts", {
        p_business_id: currentBusiness.id,
        p_organization_id: currentOrg.id,
        p_max_age_hours: 24,
      });
      if (error) throw error;
      const n = typeof data === "number" ? data : Number(data ?? 0);
      toast.success(n > 0 ? `Discarded ${n} abandoned draft(s)` : "Nothing to discard");
      await refreshStaleCount();
    } catch (err: any) {
      toast.error(err?.message || "Discard failed");
    } finally {
      setDiscarding(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, refreshStaleCount]);

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Maintenance"
        subtitle="Administrative actions for repairing or syncing employee data. Use sparingly — every action is audited."
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Wrench className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-sm">Bulk auto-link to user accounts</div>
              <p className="text-xs text-muted-foreground mt-1">
                For each <strong>active</strong> employee without a linked user account, find an
                eligible workspace member (via the secure{" "}
                <code>get_linkable_users_for_employee</code> RPC) and link them. Platform
                administrators, workspace owners, and internal users are never treated as
                candidate employees; their skip reasons are reported back.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={autoLink} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LinkIcon className="h-4 w-4 mr-2" />}
              Run
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <Trash2 className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="flex-1">
              <div className="font-medium text-sm">
                Abandoned employee drafts
                {staleDrafts !== null && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({staleDrafts} older than 24h)
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Employee records left in <code>draft</code> after the creation wizard was
                abandoned. These never appear in directory, payroll, or auto-link, but they
                accumulate over time. Safe to discard once nobody is actively editing them.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={discardDrafts}
              disabled={discarding || (staleDrafts ?? 0) === 0}
            >
              {discarding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Discard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
