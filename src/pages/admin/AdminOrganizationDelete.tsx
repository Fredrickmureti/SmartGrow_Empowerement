// @ts-nocheck - Admin tables not in auto-generated types
/**
 * Delete Organization — wizard route.
 *
 * Route: /admin-management/organizations/:id/delete
 *
 * Replaces the legacy MultiStepDeleteDialog. Rendered as a gated
 * three-step wizard (Impact review → Typed confirmation → Final warning)
 * inside `WizardShell`, matching the wizard pattern the tenant ERP uses
 * for irreversible workflows. See docs/design-system/audit/platform-admin.md.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, AlertTriangle, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  FooterActionBar,
  RecordHeader,
  WizardShell,
  WizardStepper,
  type WizardStep,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { normalizeError } from "@/services/resilience";

interface OrgSummary {
  id: string;
  name: string;
  slug: string | null;
  is_suspended?: boolean | null;
}

const STEPS: WizardStep[] = [
  { id: "impact", label: "Impact review" },
  { id: "confirm", label: "Typed confirmation" },
  { id: "final", label: "Final warning" },
];

export default function AdminOrganizationDelete() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stepId, setStepId] = useState<string>("impact");
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!id) return;
      setIsLoading(true);
      try {
        const { data, error } = await (supabase.from as any)("organizations")
          .select("id,name,slug,is_suspended")
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

  const completedStepIds = useMemo(() => {
    const done: string[] = [];
    if (stepId === "confirm" || stepId === "final") done.push("impact");
    if (stepId === "final") done.push("confirm");
    return done;
  }, [stepId]);

  const isConfirmTextValid =
    !!org && confirmText.trim().toLowerCase() === org.name.trim().toLowerCase();

  async function handleFinalDelete() {
    if (!org) return;
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("clear-org-data", {
        body: {
          organization_id: org.id,
          mode: "delete_organization",
          confirmation_token: `DELETE-${org.id}`,
        },
      });
      if (error) throw error;
      if (!data?.ok && !data?.success) {
        throw new Error(data?.error || "Organization deletion failed");
      }
      toast({
        title: "Organization deleted",
        description: `${org.name} and its tenant data have been permanently removed.`,
      });
      navigate("/admin-management/organizations");
    } catch (error: any) {
      toast({
        title: "Error deleting organization",
        description:
          normalizeError(error).message ||
          "Could not delete. It may have related data.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  }

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
          <span className="text-foreground">Delete</span>
        </nav>
      }
      eyebrow="Platform admin"
      title={
        <span className="flex items-center gap-2 text-destructive">
          <Trash2 className="h-5 w-5" />
          Delete Organization
        </span>
      }
      actions={
        <Button variant="outline" size="sm" onClick={() => navigate(backHref)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to organization
        </Button>
      }
    />
  );

  const stepper = (
    <WizardStepper
      steps={STEPS}
      activeStepId={stepId}
      completedStepIds={completedStepIds}
      onStepClick={setStepId}
    />
  );

  if (isLoading || !org) {
    return (
      <WizardShell header={header} stepper={stepper}>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </WizardShell>
    );
  }

  let body: JSX.Element;
  let footer: JSX.Element;

  if (stepId === "impact") {
    body = (
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-foreground">
                You are about to permanently delete{" "}
                <span className="text-foreground">{org.name}</span>.
              </p>
              <p className="text-muted-foreground">
                This action removes the tenant and every downstream record.
                The organization cannot be restored after this wizard commits.
              </p>
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <p className="font-medium text-foreground">Data that will be removed</p>
            <ul className="list-disc space-y-1 pl-6 text-muted-foreground">
              <li>All team members, invitations, and RBAC assignments</li>
              <li>All invoices, expenses, journals, and financial history</li>
              <li>All products, contacts, documents, and attachments</li>
              <li>All workspace settings, integrations, and configurations</li>
              <li>All audit trail entries scoped to this tenant</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    );
    footer = (
      <FooterActionBar>
        <div className="flex w-full items-center justify-between">
          <Button variant="ghost" onClick={() => navigate(backHref)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => setStepId("confirm")}>
            I understand, continue
          </Button>
        </div>
      </FooterActionBar>
    );
  } else if (stepId === "confirm") {
    body = (
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-foreground">Typed confirmation required</p>
              <p className="text-muted-foreground">
                Type the organization name exactly as shown to unlock the final
                warning step.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-name">
              Type <strong className="text-foreground">{org.name}</strong> to confirm
            </Label>
            <Input
              id="confirm-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={org.name}
              autoComplete="off"
            />
          </div>
        </CardContent>
      </Card>
    );
    footer = (
      <FooterActionBar>
        <div className="flex w-full items-center justify-between">
          <Button variant="outline" onClick={() => setStepId("impact")}>
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={() => setStepId("final")}
            disabled={!isConfirmTextValid}
          >
            Continue to final warning
          </Button>
        </div>
      </FooterActionBar>
    );
  } else {
    body = (
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-start gap-3 rounded-md border border-destructive bg-destructive/10 p-4">
            <Trash2 className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold text-destructive">
                This action cannot be undone.
              </p>
              <p className="text-muted-foreground">
                Once you commit, {org.name} and every associated record will be
                permanently deleted. Are you absolutely sure?
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
    footer = (
      <FooterActionBar>
        <div className="flex w-full items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStepId("confirm")}
            disabled={isDeleting}
          >
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={handleFinalDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="mr-2 h-4 w-4" />
                Yes, delete forever
              </>
            )}
          </Button>
        </div>
      </FooterActionBar>
    );
  }

  return (
    <WizardShell header={header} stepper={stepper} footer={footer}>
      {body}
    </WizardShell>
  );
}
