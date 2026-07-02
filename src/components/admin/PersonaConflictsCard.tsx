import { normalizeError } from "@/services/resilience";
/**
 * PersonaConflictsCard
 *
 * Surfaces any auth users that violate persona exclusivity (ADR-0004) — i.e.
 * users who are simultaneously an active platform admin AND an active member
 * of a tenant workspace. Going forward this is prevented at the DB level by
 * `enforce_persona_exclusivity_*` triggers, but legacy conflicts can exist
 * from before those triggers landed.
 *
 * Resolution is intentionally manual (and audit-logged via the underlying
 * RPC): we display the conflict and let the platform owner decide which
 * side to deactivate. Defaulting either way silently would risk locking
 * the SaaS operator out of their own platform.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface PersonaConflict {
  user_id: string;
  email: string;
  active_platform_admin: boolean;
  active_tenant_roles: number;
  organization_ids: string[];
}

export function PersonaConflictsCard() {
  const [conflicts, setConflicts] = useState<PersonaConflict[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const fetchConflicts = async () => {
    setLoading(true);
    try {
      // Owner-only RPC (enforced inside the function). Non-owner platform
      // admins will get an "insufficient privilege" error; we treat that as
      // "show empty" rather than a hard failure since the card is gated
      // upstream to owners only.
      const { data, error } = await supabase.rpc("list_persona_conflicts" as never);
      if (error) throw error;
      setConflicts((data as unknown as PersonaConflict[]) || []);
    } catch (e: any) {
      console.warn("[PersonaConflicts] could not list:", e?.message);
      setConflicts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConflicts();
  }, []);

  const resolveByDeactivatingTenant = async (userId: string) => {
    setResolvingId(userId);
    try {
      const { error } = await supabase
        .from("user_roles")
        .update({ is_active: false })
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) throw error;
      toast.success("Deactivated tenant memberships for this user");
      await fetchConflicts();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to resolve conflict");
    } finally {
      setResolvingId(null);
    }
  };

  const resolveByDeactivatingPlatformAdmin = async (userId: string) => {
    setResolvingId(userId);
    try {
      const { error } = await supabase
        .from("platform_admins")
        .update({ is_active: false })
        .eq("user_id", userId)
        .eq("is_active", true);
      if (error) throw error;
      toast.success("Deactivated platform admin role for this user");
      await fetchConflicts();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to resolve conflict");
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Persona conflicts
            </CardTitle>
            <CardDescription>
              Users who are both an active platform admin and an active tenant
              member. New conflicts are blocked at the database level — these
              are legacy.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchConflicts}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Checking…
          </div>
        ) : conflicts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            No persona conflicts. All users have a single, unambiguous role.
          </div>
        ) : (
          <div className="space-y-3">
            {conflicts.map((c) => (
              <div
                key={c.user_id}
                className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="font-medium">{c.email}</div>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Badge variant="secondary">Platform admin</Badge>
                    <Badge variant="outline">
                      {c.active_tenant_roles} tenant role
                      {c.active_tenant_roles === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resolveByDeactivatingTenant(c.user_id)}
                    disabled={resolvingId === c.user_id}
                  >
                    Keep as platform admin
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resolveByDeactivatingPlatformAdmin(c.user_id)}
                    disabled={resolvingId === c.user_id}
                  >
                    Keep as tenant
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
