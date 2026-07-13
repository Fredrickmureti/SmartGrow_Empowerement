// @ts-nocheck - Admin tables not in auto-generated types
/**
 * Manage Subscription — workspace route.
 *
 * Route: /admin-management/organizations/:id/subscription
 *
 * Replaces the legacy ManageSubscriptionDialog. Rendered inside
 * `AdminRecordPage` so admin lifecycle work sits inside the same
 * record-workspace pattern the tenant ERP uses everywhere else. See
 * `docs/design-system/audit/platform-admin.md`.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, CreditCard, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { RecordHeader } from "@/design-system";
import { AdminRecordPage } from "@/apps/platform-admin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ManageSubscriptionPanel,
  type ManageSubscriptionOrganization,
} from "@/components/admin/ManageSubscriptionPanel";
import { normalizeError } from "@/services/resilience";

export default function AdminOrganizationSubscription() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [org, setOrg] = useState<ManageSubscriptionOrganization | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!id) return;
      setIsLoading(true);
      try {
        const { data, error } = await (supabase.from as any)("organizations")
          .select(
            "id,name,subscription_plan_id,subscription_status,subscription_started_at,subscription_ends_at,trial_ends_at,is_suspended",
          )
          .eq("id", id)
          .single();
        if (error) throw error;
        if (!cancelled) setOrg(data);
      } catch (error: any) {
        toast({
          title: "Unable to load organization",
          description: normalizeError(error).message || "Please try again.",
          variant: "destructive",
        });
        navigate("/admin-management/organizations");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id, navigate, toast]);

  const backHref = id
    ? `/admin-management/organizations/${id}`
    : "/admin-management/organizations";

  const header = (
    <RecordHeader
      breadcrumb={
        <nav className="flex items-center gap-1 text-muted-foreground">
          <Link to="/admin-management/organizations" className="hover:text-foreground">
            Organizations
          </Link>
          <span>›</span>
          <Link to={backHref} className="hover:text-foreground">
            {org?.name ?? "Organization"}
          </Link>
          <span>›</span>
          <span className="text-foreground">Subscription</span>
        </nav>
      }
      eyebrow="Platform admin"
      title={
        <span className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Manage Subscription
        </span>
      }
      meta={
        org && (
          <>
            <span className="font-medium text-foreground">{org.name}</span>
            {org.subscription_status && (
              <Badge variant="outline">{org.subscription_status}</Badge>
            )}
          </>
        )
      }
      actions={
        <Button variant="outline" size="sm" onClick={() => navigate(backHref)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to organization
        </Button>
      }
    />
  );

  return (
    <AdminRecordPage header={header}>
      {isLoading || !org ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ManageSubscriptionPanel
          organization={org}
          footer="attached"
          onSaved={() => navigate(backHref)}
          onCancel={() => navigate(backHref)}
        />
      )}
    </AdminRecordPage>
  );
}
