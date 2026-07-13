/**
 * AdminOrgLocalizationInstallPage — guided wizard for installing a
 * localization pack on a tenant, invoked from the Organization workspace
 * at `/admin-management/organizations/:id/localization/install`.
 *
 * Follows the audit doc's 4-pattern classification: any multi-decision
 * side-effect commit belongs in `AdminWizard`, not a dialog. Steps:
 *
 *   1. Choose company (business) within the organization
 *   2. Choose pack + surface conflict with the currently-installed pack
 *   3. Confirm & install (typed confirmation, force_reseed, ack skeleton)
 *
 * Backed by the `install-localization-pack` edge function, which now
 * accepts a platform-admin on-behalf-of caller (the function checks
 * `is_platform_admin` when the actor lacks a user_role in the target
 * organization). No schema changes.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Globe } from "lucide-react";

import {
  AdminWizard,
  AdminWizardStepper,
  AdminFooterActionBar,
} from "@/apps/platform-admin";
import {
  RecordHeader,
  Section,
  LoadingState,
  StatusBadge,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminFrom } from "@/lib/adminClient";
import { invokeWithAuth } from "@/integrations/supabase/invokeWithAuth";
import { usePacks } from "@/features/localization/hooks/usePack";
import { normalizeError } from "@/services/resilience";

const STEPS = [
  { id: "target", label: "Choose company" },
  { id: "pack", label: "Choose pack" },
  { id: "confirm", label: "Confirm & install" },
];

interface Business {
  id: string;
  name: string;
  country: string | null;
}

interface Installed {
  id: string;
  business_id: string;
  pack_id: string;
  pack_version: string | null;
  status: string;
  installed_at: string | null;
}

const DETAIL_PATH = (id: string) => `/admin-management/organizations/${id}`;

export default function AdminOrgLocalizationInstallPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const orgId = id ?? "";

  const [activeStep, setActiveStep] = useState<string>("target");
  const [businessId, setBusinessId] = useState<string>("");
  const [packId, setPackId] = useState<string>("");
  const [forceReseed, setForceReseed] = useState(false);
  const [ackSkeleton, setAckSkeleton] = useState(false);
  const [confirmToken, setConfirmToken] = useState("");

  const orgQuery = useQuery({
    queryKey: ["admin-org", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await adminFrom("organizations")
        .select("id, name")
        .eq("id", orgId)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; name: string } | null;
    },
  });

  const businessesQuery = useQuery({
    queryKey: ["admin-org-businesses", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Business[]> => {
      const { data, error } = await adminFrom("businesses")
        .select("id, name, country")
        .eq("organization_id", orgId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as Business[];
    },
  });

  const installedQuery = useQuery({
    queryKey: ["admin-org-installed-packs", orgId],
    enabled: !!orgId,
    queryFn: async (): Promise<Installed[]> => {
      const bizIds = (businessesQuery.data ?? []).map((b) => b.id);
      if (bizIds.length === 0) return [];
      const { data, error } = await adminFrom("installed_localization_packs")
        .select("id, business_id, pack_id, pack_version, status, installed_at")
        .in("business_id", bizIds);
      if (error) throw error;
      return (data ?? []) as Installed[];
    },
    // Depend on businesses being loaded first
    // (react-query re-runs when queryKey changes; we key off businessesQuery below).
  });

  const packsQuery = usePacks({ scope: "admin" });

  const install = useMutation({
    mutationFn: async () => {
      const { data, error } = await invokeWithAuth("install-localization-pack", {
        body: {
          organization_id: orgId,
          business_id: businessId,
          pack_id: packId,
          force_reseed: forceReseed,
          acknowledge_skeleton: ackSkeleton,
        },
      });
      if (error) throw error;
      if ((data as any)?.error || (data as any)?.success === false) {
        throw new Error((data as any)?.error ?? "Install failed");
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-org-installed-packs", orgId] });
      qc.invalidateQueries({ queryKey: ["installed-localization-packs"] });
      toast.success("Localization pack installed");
      navigate(DETAIL_PATH(orgId));
    },
    onError: (err) => {
      toast.error(normalizeError(err).message);
    },
  });

  const business = useMemo(
    () => (businessesQuery.data ?? []).find((b) => b.id === businessId) ?? null,
    [businessesQuery.data, businessId],
  );

  const pack = useMemo(
    () => (packsQuery.data ?? []).find((p) => p.id === packId) ?? null,
    [packsQuery.data, packId],
  );

  const currentInstall = useMemo(
    () => (installedQuery.data ?? []).find((r) => r.business_id === businessId) ?? null,
    [installedQuery.data, businessId],
  );

  const hasConflict =
    !!currentInstall && !!packId && currentInstall.pack_id !== packId;
  const isReinstall =
    !!currentInstall && !!packId && currentInstall.pack_id === packId;

  if (orgQuery.isLoading || businessesQuery.isLoading) return <LoadingState />;
  if (!orgQuery.data) {
    navigate("/admin-management/organizations", { replace: true });
    return null;
  }
  const org = orgQuery.data;

  const completedSteps: string[] = [];
  if (businessId) completedSteps.push("target");
  if (packId) completedSteps.push("pack");

  const canAdvanceFromTarget = !!businessId;
  const canAdvanceFromPack = !!packId;
  const canInstall =
    confirmToken.trim().toUpperCase() === "INSTALL" &&
    !install.isPending &&
    canAdvanceFromPack &&
    canAdvanceFromTarget;

  const goNext = () => {
    if (activeStep === "target" && canAdvanceFromTarget) setActiveStep("pack");
    else if (activeStep === "pack" && canAdvanceFromPack) setActiveStep("confirm");
  };
  const goBack = () => {
    if (activeStep === "pack") setActiveStep("target");
    else if (activeStep === "confirm") setActiveStep("pack");
    else navigate(DETAIL_PATH(orgId));
  };

  return (
    <AdminWizard
      header={
        <RecordHeader
          eyebrow="Install localization pack"
          title={
            <span className="inline-flex items-center gap-2">
              <Globe className="h-5 w-5" />
              {org.name}
            </span>
          }
          status={<StatusBadge tone="neutral">Platform admin</StatusBadge>}
          meta={<span>On-behalf-of install</span>}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(DETAIL_PATH(orgId))}
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back to organization
            </Button>
          }
        />
      }
      stepper={
        <AdminWizardStepper
          steps={STEPS}
          activeStepId={activeStep}
          completedStepIds={completedSteps}
          onStepClick={setActiveStep}
        />
      }
      footer={
        <AdminFooterActionBar
          leading={
            <Button variant="outline" onClick={goBack}>
              {activeStep === "target" ? "Cancel" : "Back"}
            </Button>
          }
          trailing={
            <ActionBar>
              {activeStep !== "confirm" ? (
                <Button
                  onClick={goNext}
                  disabled={
                    (activeStep === "target" && !canAdvanceFromTarget) ||
                    (activeStep === "pack" && !canAdvanceFromPack)
                  }
                >
                  Continue
                </Button>
              ) : (
                <Button
                  onClick={() => install.mutate()}
                  disabled={!canInstall}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {install.isPending
                    ? "Installing…"
                    : isReinstall
                      ? "Reinstall pack"
                      : "Install pack"}
                </Button>
              )}
            </ActionBar>
          }
        />
      }
    >
      {activeStep === "target" && (
        <Section
          title="Choose company"
          description="Localization is installed per Company (business) within this organization."
        >
          <div className="space-y-4">
            {(businessesQuery.data ?? []).length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  This organization has no companies yet. Localization is
                  scoped per Company — create one before installing a pack.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="business">Company *</Label>
                <Select value={businessId} onValueChange={setBusinessId}>
                  <SelectTrigger id="business">
                    <SelectValue placeholder="Select a company…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(businessesQuery.data ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                        {b.country ? ` — ${b.country}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </Section>
      )}

      {activeStep === "pack" && (
        <Section
          title="Choose pack"
          description={
            business
              ? `Available packs for ${business.name}${business.country ? ` (${business.country})` : ""}.`
              : "Available published packs."
          }
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pack">Localization pack *</Label>
              <Select value={packId} onValueChange={setPackId}>
                <SelectTrigger id="pack">
                  <SelectValue placeholder="Select a pack…" />
                </SelectTrigger>
                <SelectContent>
                  {(packsQuery.data ?? [])
                    .filter((p) => p.is_active && p.is_published)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} — {p.country_code} · v{p.version}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {currentInstall && (
              <Card
                className={
                  hasConflict
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-muted"
                }
              >
                <CardContent className="p-4 space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      Currently installed
                    </span>
                    <StatusBadge tone={hasConflict ? "warning" : "neutral"}>
                      {currentInstall.status}
                    </StatusBadge>
                  </div>
                  <p>
                    Pack <span className="font-mono">{currentInstall.pack_id}</span>{" "}
                    · v{currentInstall.pack_version ?? "?"}
                  </p>
                  {hasConflict && (
                    <p className="text-xs text-amber-900 dark:text-amber-200">
                      Installing a different pack on this company. The install
                      will refuse unless you enable “Force reseed” on the
                      confirm step.
                    </p>
                  )}
                  {isReinstall && (
                    <p className="text-xs text-muted-foreground">
                      Same pack already installed — this will be a reinstall.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </Section>
      )}

      {activeStep === "confirm" && (
        <Section
          title="Confirm install"
          description="Seeds taxes, GL accounts and payroll statutory rules for the chosen company."
        >
          <div className="space-y-4">
            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <SummaryRow label="Organization" value={org.name} />
                <SummaryRow
                  label="Company"
                  value={
                    business
                      ? `${business.name}${business.country ? ` (${business.country})` : ""}`
                      : "—"
                  }
                />
                <SummaryRow
                  label="Pack"
                  value={
                    pack
                      ? `${pack.name} — ${pack.country_code} · v${pack.version}`
                      : "—"
                  }
                />
                <SummaryRow
                  label="Existing install"
                  value={
                    currentInstall
                      ? `${currentInstall.status} · v${currentInstall.pack_version ?? "?"}`
                      : "None"
                  }
                />
              </CardContent>
            </Card>

            {(hasConflict || isReinstall) && (
              <div className="flex items-start gap-3 rounded-md border p-3">
                <input
                  id="force-reseed"
                  type="checkbox"
                  checked={forceReseed}
                  onChange={(e) => setForceReseed(e.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <div className="space-y-0.5">
                  <Label htmlFor="force-reseed" className="cursor-pointer">
                    Force reseed
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Overwrite existing seed rows for this Company. Required
                    when replacing one pack with another.
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-start gap-3 rounded-md border p-3">
              <input
                id="ack-skeleton"
                type="checkbox"
                checked={ackSkeleton}
                onChange={(e) => setAckSkeleton(e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <div className="space-y-0.5">
                <Label htmlFor="ack-skeleton" className="cursor-pointer">
                  Acknowledge skeleton packs
                </Label>
                <p className="text-xs text-muted-foreground">
                  Required if the chosen pack is flagged
                  <span className="font-mono"> maturity='skeleton' </span>
                  — the pack lacks production-grade content.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-token">
                Type <span className="font-mono">INSTALL</span> to confirm
              </Label>
              <Input
                id="confirm-token"
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
                placeholder="INSTALL"
                autoComplete="off"
              />
            </div>
          </div>
        </Section>
      )}
    </AdminWizard>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
