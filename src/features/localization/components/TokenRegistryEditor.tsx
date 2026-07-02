/**
 * TokenRegistryEditor — manages `pack_token_registry` entries for a pack.
 *
 * Tokens are the contract between pack authors and the shared resolver
 * (`supabase/functions/_shared/renderTokens.ts`). Every certificate, return,
 * or template body references values by token path; missing tokens render
 * as `‹unresolved:…›` and emit `payroll_diagnostics`. Letting publishers
 * declare tokens via UI closes the last SQL-required gap in pack authoring.
 *
 * Behaviour:
 *   - Platform-reserved tokens (pack_id IS NULL) are shown for reference
 *     but are not editable here.
 *   - Pack-scoped tokens can be created, edited, deprecated, or deleted.
 *   - Deletion is blocked when any certificate or return template body in
 *     the same pack references the token path (best-effort `body::text`
 *     scan). Deprecation is offered as the safer alternative.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, Plus, Trash2, AlertTriangle } from "lucide-react";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import {
  usePackTokenRegistry, useUpsertPackToken, useDeletePackToken, usePackTokenConsumers,
  type PackTokenRow, type UpsertPackTokenInput,
} from "../hooks/useTokenRegistryAdmin";
import { normalizeError } from "@/services/resilience";

const SOURCE_HINTS = [
  { value: "employee", label: "Employee — per-employee identifier / field" },
  { value: "employer", label: "Employer — organisation-level identifier" },
  { value: "system", label: "System / aggregate — payroll computation totals" },
  { value: "period", label: "Period — pay period metadata" },
  { value: "authority", label: "Authority — statutory body metadata" },
  { value: "custom", label: "Custom — pack-specific" },
];

const DATA_TYPES = [
  "string", "text", "currency", "number", "integer", "decimal", "date", "boolean", "json",
];

const EMPTY: UpsertPackTokenInput = {
  pack_id: "",
  token_path: "",
  source: "employee",
  data_type: "string",
  description: "",
  sample_value: null,
  deprecated_in_version: null,
  replaces: null,
};

interface Props {
  packId: string | null;
}

export function TokenRegistryEditor({ packId }: Props) {
  const { data, isLoading } = usePackTokenRegistry(packId);
  const upsert = useUpsertPackToken();
  const del = useDeletePackToken();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PackTokenRow | null>(null);
  const [draft, setDraft] = useState<UpsertPackTokenInput>(EMPTY);
  const [sampleText, setSampleText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PackTokenRow | null>(null);
  const consumers = usePackTokenConsumers(packId, deleteTarget?.token_path ?? null);

  const { platformTokens, packTokens } = useMemo(() => {
    const rows = (data ?? []) as PackTokenRow[];
    return {
      platformTokens: rows.filter((r) => r.pack_id === null),
      packTokens: rows.filter((r) => r.pack_id !== null),
    };
  }, [data]);

  if (!packId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Select a pack to manage its token registry.
        </CardContent>
      </Card>
    );
  }
  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading tokens…
      </div>
    );
  }

  const openCreate = () => {
    setEditing(null);
    setDraft({ ...EMPTY, pack_id: packId });
    setSampleText("");
    setEditorOpen(true);
  };
  const openEdit = (row: PackTokenRow) => {
    setEditing(row);
    setDraft({
      id: row.id,
      pack_id: packId,
      token_path: row.token_path,
      source: row.source,
      data_type: row.data_type,
      description: row.description ?? "",
      sample_value: row.sample_value,
      deprecated_in_version: row.deprecated_in_version,
      replaces: row.replaces,
    });
    setSampleText(row.sample_value == null ? "" : JSON.stringify(row.sample_value));
    setEditorOpen(true);
  };

  const submit = async () => {
    let sample: unknown = null;
    if (sampleText.trim()) {
      try {
        sample = JSON.parse(sampleText);
      } catch {
        sample = sampleText;
      }
    }
    try {
      await upsert.mutateAsync({ ...draft, sample_value: sample });
      toast.success(editing ? "Token updated" : "Token declared");
      setEditorOpen(false);
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if ((consumers.data ?? []).length > 0) {
      toast.error("Cannot delete — token is referenced by templates. Deprecate instead.");
      return;
    }
    try {
      await del.mutateAsync({ id: deleteTarget.id, pack_id: packId });
      toast.success("Token deleted");
      setDeleteTarget(null);
    } catch (e) {
      toast.error(normalizeError(e).message);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-sm">Pack tokens</CardTitle>
            <p className="text-xs text-muted-foreground">
              Values templates can render. Path format: <span className="font-mono">source.path</span>.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New token
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {packTokens.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No pack-scoped tokens yet. Declare one to make a country-specific identifier
              (e.g. tax PIN, social security number) available in templates.
            </div>
          )}
          {packTokens.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b last:border-0 py-2">
              <div className="min-w-0">
                <div className="text-sm font-mono truncate">{t.token_path}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {t.source} · {t.data_type}
                  {t.deprecated_in_version && (
                    <Badge variant="destructive" className="ml-2 text-[10px]">
                      deprecated v{t.deprecated_in_version}
                    </Badge>
                  )}
                  {t.description && <span className="ml-2">· {t.description}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(t)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => setDeleteTarget(t)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Platform-reserved tokens</CardTitle>
          <p className="text-xs text-muted-foreground">
            Maintained by the platform. Available to every pack — no action required to use them.
          </p>
        </CardHeader>
        <CardContent className="space-y-1 max-h-96 overflow-y-auto">
          {platformTokens.length === 0 && (
            <div className="text-sm text-muted-foreground">None.</div>
          )}
          {platformTokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between border-b last:border-0 py-1.5 text-xs">
              <span className="font-mono truncate">{t.token_path}</span>
              <span className="text-muted-foreground shrink-0 ml-2">{t.source} · {t.data_type}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <LocalizationFormShell
        open={editorOpen}
        onOpenChange={setEditorOpen}
        entity="pack-token"
        mode={editing ? "edit" : "create"}
        busy={upsert.isPending}
        submitDisabled={!draft.token_path.trim() || !draft.source.trim() || !draft.data_type.trim()}
        onSubmit={submit}
      >
        <WorkflowSheetSection
          number={1}
          title="Identity"
          subtitle="Token path is what authors type into template bodies. Convention: source.field (e.g. employee.tax_pin)."
        >
          <WorkflowSheetGrid>
            <WorkflowField label="Token path" required>
              <Input
                value={draft.token_path}
                onChange={(e) => setDraft({ ...draft, token_path: e.target.value })}
                placeholder="employee.tax_pin"
                autoFocus
                className="font-mono"
              />
            </WorkflowField>
            <WorkflowField label="Source" required>
              <Select value={draft.source} onValueChange={(v) => setDraft({ ...draft, source: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCE_HINTS.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Data type" required>
              <Select value={draft.data_type} onValueChange={(v) => setDraft({ ...draft, data_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DATA_TYPES.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Sample value (for previews)">
              <Input
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder='e.g. "A001234567B" or 50000'
              />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>

        <WorkflowSheetSection
          number={2}
          title="Documentation"
          subtitle="Description shown in the token picker. Lifecycle fields signal authors when a token is retiring."
        >
          <WorkflowSheetGrid>
            <WorkflowField label="Description">
              <Textarea
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Kenyan KRA tax PIN as registered with iTax."
                rows={3}
              />
            </WorkflowField>
            <WorkflowField label="Deprecated in version">
              <Input
                value={draft.deprecated_in_version ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, deprecated_in_version: e.target.value.trim() || null })
                }
                placeholder="2.0.0"
              />
            </WorkflowField>
            <WorkflowField label="Replaced by (token path)">
              <Input
                value={draft.replaces ?? ""}
                onChange={(e) => setDraft({ ...draft, replaces: e.target.value.trim() || null })}
                placeholder="employee.tax_pin_v2"
                className="font-mono"
              />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      </LocalizationFormShell>

      <LocalizationFormShell
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        entity="pack-token"
        title={deleteTarget ? `Delete ${deleteTarget.token_path}?` : undefined}
        description="This token will no longer resolve. Templates referencing it will render the unresolved sentinel at runtime."
        busy={del.isPending}
        submitLabel="Delete token"
        submitDisabled={(consumers.data ?? []).length > 0}
        onSubmit={confirmDelete}
      >
        <WorkflowSheetSection number={1} title="Impact analysis" subtitle="Templates referencing this token within the same pack.">
          {consumers.isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning consumers…
            </div>
          ) : (consumers.data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No template currently references this token. Safe to delete.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Blocked — {(consumers.data ?? []).length} template(s) reference this token. Deprecate
                instead so authors can migrate.
              </div>
              <div className="border rounded-md divide-y text-xs">
                {(consumers.data ?? []).map((c) => (
                  <div key={`${c.table}:${c.id}`} className="px-2 py-1.5 flex items-center justify-between">
                    <span className="font-mono">{c.code}</span>
                    <span className="text-muted-foreground">
                      {c.display_name ?? ""} · {c.table.replace("localization_pack_", "")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </WorkflowSheetSection>
      </LocalizationFormShell>
    </div>
  );
}
