/**
 * AdminLocalizationPackPublishPage — guided wizard for publishing a new
 * version of a localization pack at
 * `/admin-management/localization-packs/:id/publish`.
 *
 * Enterprise ERP-style multi-step commit: metadata → review → confirm.
 * Backed by `usePublishPackVersion()` which calls the existing
 * `publish-localization-pack-version` edge function (no schema changes).
 * See docs/adr/0056-localization-publisher-parity.md.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Package, ArrowLeft } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { adminFrom } from "@/lib/adminClient";
import {
  usePack,
  usePackVersions,
  usePublishPackVersion,
  useCertificateTemplateHealth,
  usePackHealth,
} from "@/features/localization/hooks/usePack";
import { normalizeError } from "@/services/resilience";

const STEPS = [
  { id: "metadata", label: "Version metadata" },
  { id: "review", label: "Review & preflight" },
  { id: "confirm", label: "Confirm & publish" },
];

const DETAIL_PATH = (id: string) => `/admin-management/localization-packs/${id}`;

export default function AdminLocalizationPackPublishPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const packId = id ?? "";

  const { data: pack, isLoading: packLoading } = usePack(packId);
  const { data: versions } = usePackVersions(packId);
  const { data: certHealth } = useCertificateTemplateHealth(packId);
  const { data: legacyRules } = usePackHealth(packId);
  const publish = usePublishPackVersion();

  // Tenants currently on this pack — surfaced in Step 2 as impact preview.
  const { data: installCount } = useQuery({
    queryKey: ["admin-pack-install-count", packId],
    enabled: !!packId,
    queryFn: async () => {
      const { data, error } = await adminFrom("installed_localization_packs")
        .select("organization_id")
        .eq("pack_id", packId);
      if (error) throw error;
      return (data ?? []).length;
    },
  });

  const [activeStep, setActiveStep] = useState<string>("metadata");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [proposeUpgrades, setProposeUpgrades] = useState(true);
  const [confirmToken, setConfirmToken] = useState("");

  // Once the pack loads, seed the version bump: "1.0.0" → "1.0.1".
  useMemo(() => {
    if (!pack || version) return;
    const parts = (pack.version ?? "1.0.0").split(".").map((n) => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    parts[2] = (Number.isFinite(parts[2]) ? parts[2] : 0) + 1;
    setVersion(parts.join("."));
  }, [pack, version]);

  if (packLoading) return <LoadingState />;
  if (!pack) {
    navigate("/admin-management/localization-packs", { replace: true });
    return null;
  }

  const latestPublished = (versions ?? []).find((v) => v.status === "published");
  const legacyCount = legacyRules?.length ?? 0;
  const certLegacyCount = certHealth?.legacy?.length ?? 0;
  const certMissingMeta = certHealth?.missingMetadata?.length ?? 0;
  const hardBlockers = certLegacyCount + certMissingMeta;

  const completedSteps: string[] = [];
  if (version.trim()) completedSteps.push("metadata");
  if (activeStep === "confirm" || completedSteps.includes("metadata"))
    completedSteps.push("review");

  const canAdvanceFromMetadata = version.trim().length > 0;
  const canPublish =
    confirmToken.trim().toUpperCase() === "PUBLISH" && !publish.isPending;

  const handlePublish = async () => {
    try {
      await publish.mutateAsync({
        pack_id: pack.id,
        version: version.trim(),
        notes: notes.trim() || undefined,
        propose_upgrades: proposeUpgrades,
      });
      toast.success(`Version ${version} published`);
      navigate(DETAIL_PATH(pack.id));
    } catch (err) {
      toast.error(normalizeError(err).message);
    }
  };

  const goNext = () => {
    if (activeStep === "metadata" && canAdvanceFromMetadata) setActiveStep("review");
    else if (activeStep === "review") setActiveStep("confirm");
  };
  const goBack = () => {
    if (activeStep === "review") setActiveStep("metadata");
    else if (activeStep === "confirm") setActiveStep("review");
    else navigate(DETAIL_PATH(pack.id));
  };

  return (
    <AdminWizard
      header={
        <RecordHeader
          eyebrow="Publish localization pack version"
          title={
            <span className="inline-flex items-center gap-2">
              <Package className="h-5 w-5" />
              {pack.name}
            </span>
          }
          docNumber={`current v${pack.version}`}
          status={
            <StatusBadge tone={pack.is_published ? "success" : "neutral"}>
              {pack.is_published ? "Published" : "Draft"}
            </StatusBadge>
          }
          meta={<span>{pack.country_code}</span>}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(DETAIL_PATH(pack.id))}
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back to pack
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
              {activeStep === "metadata" ? "Cancel" : "Back"}
            </Button>
          }
          trailing={
            <ActionBar>
              {activeStep !== "confirm" ? (
                <Button
                  onClick={goNext}
                  disabled={activeStep === "metadata" && !canAdvanceFromMetadata}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  onClick={handlePublish}
                  disabled={!canPublish}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {publish.isPending ? "Publishing…" : `Publish v${version}`}
                </Button>
              )}
            </ActionBar>
          }
        />
      }
    >
      {activeStep === "metadata" && (
        <Section
          title="Version metadata"
          description="Semantic version and changelog notes that will accompany the snapshot."
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-version">New version *</Label>
              <Input
                id="new-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 1.1.0"
              />
              <p className="text-xs text-muted-foreground">
                Latest published: {latestPublished ? `v${latestPublished.version}` : "none"}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-notes">Changelog notes</Label>
              <Textarea
                id="new-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={5}
                placeholder="What changed in this version? Highlight legal references, rule updates, breaking changes…"
              />
            </div>
            <div className="flex items-center gap-3 rounded-md border p-3">
              <input
                id="propose-upgrades"
                type="checkbox"
                checked={proposeUpgrades}
                onChange={(e) => setProposeUpgrades(e.target.checked)}
                className="h-4 w-4"
              />
              <div className="space-y-0.5">
                <Label htmlFor="propose-upgrades" className="cursor-pointer">
                  Propose upgrade to installed tenants
                </Label>
                <p className="text-xs text-muted-foreground">
                  Creates a pending upgrade proposal for every organization currently on this pack.
                </p>
              </div>
            </div>
          </div>
        </Section>
      )}

      {activeStep === "review" && (
        <>
          <Section
            title="Preflight checks"
            description="Anything red will hard-block publish."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <PreflightCard
                label="Legacy statutory rules"
                value={legacyCount}
                tone={legacyCount === 0 ? "success" : "warning"}
                hint={
                  legacyCount === 0
                    ? "All rules validated against the schema"
                    : "Legacy rows carried over from before the schema validator — re-save them before publishing"
                }
              />
              <PreflightCard
                label="Legacy certificate templates"
                value={certLegacyCount}
                tone={certLegacyCount === 0 ? "success" : "error"}
                hint={
                  certLegacyCount === 0
                    ? "All templates validated (v2 editor)"
                    : "Publish will refuse — re-save through the v2 template editor"
                }
              />
              <PreflightCard
                label="Certificates missing legal metadata"
                value={certMissingMeta}
                tone={certMissingMeta === 0 ? "success" : "error"}
                hint={
                  certMissingMeta === 0
                    ? "Every template carries authority + legal reference + effective date"
                    : "Publish will refuse — add authority, legal reference, and effective date on each"
                }
              />
              <PreflightCard
                label="Tenants currently installed"
                value={installCount ?? 0}
                tone="neutral"
                hint={
                  proposeUpgrades
                    ? "Each will receive an upgrade proposal once you commit"
                    : "Upgrade proposals disabled — installed tenants stay on their current version"
                }
              />
            </div>
          </Section>

          {hardBlockers > 0 && (
            <Section
              title="Blockers"
              description="Publishing is disabled while these are unresolved."
            >
              <Card className="border-destructive/40 bg-destructive/5">
                <CardContent className="p-4 space-y-2">
                  {certLegacyCount > 0 && (
                    <p className="text-sm">
                      <Badge variant="destructive" className="mr-2">Legacy</Badge>
                      {certLegacyCount} certificate template{certLegacyCount === 1 ? "" : "s"} must be re-saved
                    </p>
                  )}
                  {certMissingMeta > 0 && (
                    <p className="text-sm">
                      <Badge variant="destructive" className="mr-2">Metadata</Badge>
                      {certMissingMeta} template{certMissingMeta === 1 ? "" : "s"} missing legal metadata
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(DETAIL_PATH(pack.id))}
                  >
                    Fix in pack editor
                  </Button>
                </CardContent>
              </Card>
            </Section>
          )}
        </>
      )}

      {activeStep === "confirm" && (
        <Section
          title="Confirm publish"
          description={`This will snapshot the pack, mark v${version} as published, and — if enabled — notify ${installCount ?? 0} installed tenants.`}
        >
          <div className="space-y-4">
            <Card>
              <CardContent className="p-4 space-y-2 text-sm">
                <SummaryRow label="Pack" value={`${pack.name} (${pack.country_code})`} />
                <SummaryRow label="New version" value={`v${version}`} />
                <SummaryRow
                  label="Previous"
                  value={latestPublished ? `v${latestPublished.version}` : "—"}
                />
                <SummaryRow
                  label="Installed tenants"
                  value={String(installCount ?? 0)}
                />
                <SummaryRow
                  label="Upgrade proposals"
                  value={proposeUpgrades ? "Yes — one per tenant" : "No"}
                />
                <SummaryRow
                  label="Preflight blockers"
                  value={hardBlockers === 0 ? "None" : String(hardBlockers)}
                />
              </CardContent>
            </Card>

            <div className="space-y-2">
              <Label htmlFor="confirm-token">
                Type <span className="font-mono">PUBLISH</span> to confirm
              </Label>
              <Input
                id="confirm-token"
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
                placeholder="PUBLISH"
                autoComplete="off"
              />
              {hardBlockers > 0 && (
                <p className="text-xs text-destructive">
                  Resolve the {hardBlockers} blocker{hardBlockers === 1 ? "" : "s"} before publishing.
                </p>
              )}
            </div>
          </div>
        </Section>
      )}
    </AdminWizard>
  );
}

function PreflightCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "error" | "neutral";
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
          <StatusBadge
            tone={
              tone === "success"
                ? "success"
                : tone === "warning"
                  ? "warning"
                  : tone === "error"
                    ? "danger"
                    : "neutral"
            }
          >
            {value}
          </StatusBadge>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
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
