import { normalizeError } from "@/services/resilience";
/**
 * PackEditorShell — single shared editor surface for both platform-admin
 * pack maintainers and tenant pack customizers.
 *
 *  - mode='admin'  : shows ALL packs, allows publishing new immutable
 *                    versions, and edits live `localization_pack_*` rows.
 *  - mode='tenant' : shows only packs installed for the tenant's org,
 *                    edits override rows, and surfaces upgrade proposals.
 *
 * Layout:
 *   ┌────────────┬────────────────────────────────────┐
 *   │ Pack list  │  Version timeline + entity tabs    │
 *   │            │  (Rules / Templates / Health)      │
 *   └────────────┴────────────────────────────────────┘
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Loader2, Package, GitBranch, ShieldAlert, FileText, History, Diff, ArrowUpCircle, Radio } from "lucide-react";
import { toast } from "sonner";
import {
  usePacks, usePack, usePackVersions, usePackAuditLog, usePublishPackVersion,
  usePromotePackVersion,
} from "../hooks/usePack";
import { PackDiffView } from "./PackDiffView";
import { VersionCompareCard } from "./VersionCompareCard";
import { PackHealthPanel } from "./PackHealthPanel";
import { PackEntityTabs } from "./PackEntityTabs";
import { PublisherDiagnosticsPanel } from "./PublisherDiagnosticsPanel";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Pencil } from "lucide-react";
import type { EditorMode } from "../types";

interface Props {
  mode: EditorMode;
  /** Restrict to a single pack (e.g., tenant deep-link). */
  packId?: string | null;
}

export function PackEditorShell({ mode, packId: forcedPackId }: Props) {
  const { data: packs, isLoading: packsLoading } = usePacks({
    scope: mode === "admin" ? "admin" : "tenant",
  });
  const [selectedPackId, setSelectedPackId] = useState<string | null>(forcedPackId ?? null);
  const effectivePackId = forcedPackId ?? selectedPackId;

  const { data: pack } = usePack(effectivePackId);
  const { data: versions } = usePackVersions(effectivePackId);
  const { data: audit } = usePackAuditLog({ packId: effectivePackId, limit: 50 });
  const publish = usePublishPackVersion();
  const promote = usePromotePackVersion();

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishVersion, setPublishVersion] = useState("");
  const [publishNotes, setPublishNotes] = useState("");
  const [diffOpen, setDiffOpen] = useState(false);
  /** Arbitrary version-pair compare picker state. */
  const [compareFromId, setCompareFromId] = useState<string | null>(null);
  const [compareToId, setCompareToId] = useState<string | null>(null);
  /** Promote-version dialog state. */
  const [promoteTarget, setPromoteTarget] = useState<{ id: string; version: string } | null>(null);
  const [promoteScope, setPromoteScope] = useState<"self" | "all_tenants">("self");
  const [promoteNotes, setPromoteNotes] = useState("");

  const latestTwo = useMemo(() => (versions ?? []).slice(0, 2), [versions]);

  const versionById = useMemo(() => {
    const m = new Map<string, any>();
    (versions ?? []).forEach((v) => m.set(v.id, v));
    return m;
  }, [versions]);

  const compareFrom = compareFromId ? versionById.get(compareFromId) : null;
  const compareTo = compareToId ? versionById.get(compareToId) : null;

  const handlePublish = async () => {
    if (!effectivePackId || !publishVersion.trim()) return;
    try {
      const r: any = await publish.mutateAsync({
        pack_id: effectivePackId,
        version: publishVersion.trim(),
        notes: publishNotes.trim() || undefined,
      });
      if (r?.noop_content) {
        toast.success(`Published v${publishVersion} (content identical to previous version — no tenant proposals fanned out)`);
      } else {
        toast.success(`Published v${publishVersion} — ${r?.proposals_created ?? 0} tenant proposal(s) created`);
      }
      setPublishOpen(false);
      setPublishVersion("");
      setPublishNotes("");
    } catch (e: any) {
      // Typed errors from invokeLocalizationFn — surface lint details inline.
      const code = (e as any)?.code;
      const ctx = (e as any)?.context ?? {};
      if (code === "LINT_FAILED" && Array.isArray(ctx.lint_errors)) {
        toast.error(
          `Lint failed — ${ctx.lint_errors.length} issue(s). First: ${ctx.lint_errors[0]}`,
          { duration: 8000 },
        );
      } else {
        const { describeLocalizationError } = await import("@/features/localization/lib/invokeLocalizationFn");
        toast.error(describeLocalizationError(e) ?? normalizeError(e).message ?? "Publish failed");
      }
    }
  };

  const handlePromote = async () => {
    if (!effectivePackId || !promoteTarget) return;
    try {
      const r = await promote.mutateAsync({
        pack_id: effectivePackId,
        version_id: promoteTarget.id,
        scope: promoteScope,
        notes: promoteNotes.trim() || undefined,
      });
      toast.success(
        `Promoted v${r.version} — ${r.promoted} tenant${r.promoted === 1 ? "" : "s"} updated`,
      );
      setPromoteTarget(null);
      setPromoteNotes("");
      setPromoteScope("self");
    } catch (e: any) {
      const { describeLocalizationError } = await import("@/features/localization/lib/invokeLocalizationFn");
      toast.error(describeLocalizationError(e) ?? normalizeError(e).message ?? "Promote failed");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Pack picker — full-width grid when nothing selected. */}
      {!forcedPackId && !effectivePackId && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Package className="h-4 w-4" />
              Select a pack to edit
              {packs && <Badge variant="outline" className="ml-2 text-[10px]">{packs.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {packsLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
            {!packsLoading && (packs ?? []).length === 0 && (
              <div className="text-sm text-muted-foreground">No packs available.</div>
            )}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {(packs ?? []).map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPackId(p.id)}
                  className="text-left rounded-lg border bg-card hover:bg-muted/60 hover:border-primary/40 transition-colors p-3"
                >
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
                    <span>{p.country_code}</span>
                    <span>·</span>
                    <span>v{p.version}</span>
                    {p.is_published ? (
                      <Badge variant="secondary" className="ml-auto text-[10px]">published</Badge>
                    ) : (
                      <Badge variant="outline" className="ml-auto text-[10px]">draft</Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Right pane — full width once a pack is chosen. */}
      <div className="min-w-0">
        {effectivePackId && (
          <Tabs defaultValue="edit" className="flex flex-col gap-3">
            {/* Sticky enterprise toolbar — pack identity + tabs + primary actions. */}
            <div className="sticky top-0 z-20 -mx-2 px-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b">
              <div className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex items-center gap-3">
                  {!forcedPackId && (
                    <Select
                      value={effectivePackId}
                      onValueChange={(v) => setSelectedPackId(v)}
                    >
                      <SelectTrigger className="w-[220px] h-9">
                        <Package className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
                        <SelectValue placeholder="Switch pack" />
                      </SelectTrigger>
                      <SelectContent>
                        {(packs ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name} <span className="text-muted-foreground ml-1">({p.country_code} v{p.version})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <div className="min-w-0">
                    <div className="text-base font-semibold truncate">{pack?.name ?? "Pack"}</div>
                    <div className="text-xs text-muted-foreground">
                      {pack?.country_code} · current v{pack?.version}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {!forcedPackId && (
                    <Button variant="ghost" size="sm" onClick={() => setSelectedPackId(null)}>
                      All packs
                    </Button>
                  )}
                  {latestTwo.length === 2 && (
                    <Button variant="outline" size="sm" onClick={() => setDiffOpen(true)}>
                      <Diff className="h-3.5 w-3.5 mr-1" />Compare to v{latestTwo[1].version}
                    </Button>
                  )}
                  {mode === "admin" && (
                    <Button size="sm" onClick={() => setPublishOpen(true)}>
                      <GitBranch className="h-3.5 w-3.5 mr-1" />Publish version
                    </Button>
                  )}
                </div>
              </div>
              <TabsList className="w-full justify-start overflow-x-auto rounded-none bg-transparent border-0 p-0 h-auto">
                <TabsTrigger value="edit" className="data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent px-3 py-2">
                  <Pencil className="h-3.5 w-3.5 mr-1" />Edit
                </TabsTrigger>
                <TabsTrigger value="versions" className="data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent px-3 py-2">
                  <History className="h-3.5 w-3.5 mr-1" />Versions
                </TabsTrigger>
                <TabsTrigger value="health" className="data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent px-3 py-2">
                  <ShieldAlert className="h-3.5 w-3.5 mr-1" />Health
                </TabsTrigger>
                <TabsTrigger value="diagnostics" className="data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent px-3 py-2">
                  <Radio className="h-3.5 w-3.5 mr-1" />Diagnostics
                </TabsTrigger>
                <TabsTrigger value="audit" className="data-[state=active]:border-primary data-[state=active]:bg-transparent rounded-none border-b-2 border-transparent px-3 py-2">
                  <FileText className="h-3.5 w-3.5 mr-1" />Audit
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="edit" className="m-0">
              <PackEntityTabs mode={mode} packId={effectivePackId} />
            </TabsContent>

            <TabsContent value="versions" className="m-0">
              <div className="grid gap-3 xl:grid-cols-2">
                <VersionCompareCard
                  versions={(versions ?? []) as any}
                  compareFromId={compareFromId}
                  compareToId={compareToId}
                  onChangeFrom={setCompareFromId}
                  onChangeTo={setCompareToId}
                />

                <Card>
                  <CardHeader><CardTitle className="text-sm">Version timeline</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    {(versions ?? []).length === 0 && (
                      <div className="text-muted-foreground">
                        No published versions yet. {mode === "admin" ? "Use \"Publish version\" to snapshot." : ""}
                      </div>
                    )}
                    {(versions ?? []).map((v) => (
                      <div key={v.id} className="flex items-center justify-between border-b last:border-0 py-1.5 gap-2">
                        <div className="min-w-0">
                          <span className="font-mono">v{v.version}</span>
                          <Badge variant="secondary" className="ml-2 text-[10px]">{v.status}</Badge>
                          {(v.changelog as any)?.notes && (
                            <div className="text-xs text-muted-foreground truncate mt-0.5">
                              {(v.changelog as any).notes}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-xs text-muted-foreground">
                            {v.published_at
                              ? new Date(v.published_at).toLocaleString()
                              : new Date(v.created_at).toLocaleString()}
                          </div>
                          {v.status === "published" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPromoteTarget({ id: v.id, version: v.version });
                                setPromoteScope(mode === "admin" ? "all_tenants" : "self");
                              }}
                            >
                              <ArrowUpCircle className="h-3.5 w-3.5 mr-1" />
                              Promote
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="health" className="m-0">
              <PackHealthPanel packId={effectivePackId} />
            </TabsContent>

            <TabsContent value="diagnostics" className="m-0">
              <PublisherDiagnosticsPanel packId={effectivePackId} />
            </TabsContent>

            <TabsContent value="audit" className="m-0">
              <Card>
                <CardHeader><CardTitle className="text-sm">Recent audit entries</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-xs">
                  {(audit ?? []).length === 0 && (
                    <div className="text-muted-foreground">No audit entries yet.</div>
                  )}
                  {(audit ?? []).map((a) => (
                    <div key={a.id} className="flex items-center justify-between border-b last:border-0 py-1">
                      <div>
                        <span className="font-mono">{a.action}</span>{" "}
                        <span className="text-muted-foreground">{a.entity_table}</span>
                      </div>
                      <div className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>



      {/* Publish dialog */}
      {/* Publish */}
      <LocalizationFormShell
        open={publishOpen}
        onOpenChange={setPublishOpen}
        entity="publish-version"
        busy={publish.isPending}
        submitLabel="Publish"
        onSubmit={handlePublish}
      >
        <WorkflowSheetSection number={1} title="Version" subtitle="Use semantic versioning. Bump major for breaking computation changes.">
          <WorkflowSheetGrid>
            <WorkflowField label="Version (semver)" required>
              <Input value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} placeholder="2.0.0" />
            </WorkflowField>
            <WorkflowField label="Changelog notes">
              <Input value={publishNotes} onChange={(e) => setPublishNotes(e.target.value)} placeholder="Updated PAYE bands…" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </LocalizationFormShell>

      {/* Diff */}
      <LocalizationFormShell
        open={diffOpen}
        onOpenChange={setDiffOpen}
        entity="diff-version"
        hideFooter
      >
        {latestTwo.length === 2 ? (
          <PackDiffView
            previous={latestTwo[1].snapshot}
            next={latestTwo[0].snapshot}
            title={`v${latestTwo[1].version} → v${latestTwo[0].version}`}
          />
        ) : (
          <div className="text-sm text-muted-foreground">Need at least two versions to diff.</div>
        )}
      </LocalizationFormShell>

      {/* Promote */}
      <LocalizationFormShell
        open={!!promoteTarget}
        onOpenChange={(o) => !o && setPromoteTarget(null)}
        entity="promote-version"
        title={promoteTarget ? `Promote v${promoteTarget.version}` : undefined}
        busy={promote.isPending}
        submitLabel="Promote"
        onSubmit={handlePromote}
      >
        <WorkflowSheetSection number={1} title="Scope" subtitle="Choose who this version becomes active for.">
          <WorkflowSheetGrid>
            <WorkflowField label="Scope" required>
              <Select value={promoteScope} onValueChange={(v) => setPromoteScope(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="self">Just my workspace</SelectItem>
                  {mode === "admin" && <SelectItem value="all_tenants">All installed tenants</SelectItem>}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Notes (audit)">
              <Input value={promoteNotes} onChange={(e) => setPromoteNotes(e.target.value)} placeholder="Why are you promoting this version?" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </LocalizationFormShell>
    </div>
  );
}