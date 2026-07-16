/**
 * StatutoryAuthoritiesEditor — CRUD over `statutory_authorities` scoped to a pack.
 *
 * Statutory authorities (KRA, NSSF, SHA, URA, RRA, TRA, SARS, HMRC, IRS …) are
 * pack-owned reference rows. Return templates and remittance schedules bind
 * to them via `authority_id`; without a UI publishers cannot add a new
 * authority without a SQL migration, blocking every downstream remittance/
 * return authoring flow for that authority.
 *
 * Per-authority filing cadence and submission channel already live on
 * `localization_pack_return_templates` and `localization_pack_remittance_schedules`,
 * so this editor stays focused on authority identity (code, name, portal,
 * filing endpoint, contact metadata). Deletion is blocked when any template
 * or schedule still references the row.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Pencil, Trash2, Landmark, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { normalizeError } from "@/services/resilience";
import { LocalizationEntityWorkspace } from "./_shared/LocalizationEntityWorkspace";
import type { SpreadsheetPreviewProps } from "./preview/SpreadsheetPreviewPane";

interface Row {
  id: string;
  pack_id: string | null;
  country_code: string;
  code: string;
  display_name: string;
  portal_url: string | null;
  efiling_endpoint: string | null;
  contact: any;
}

const EMPTY = (pack_id: string, country_code: string): Row => ({
  id: "",
  pack_id,
  country_code,
  code: "",
  display_name: "",
  portal_url: null,
  efiling_endpoint: null,
  contact: {},
});

export function StatutoryAuthoritiesEditor({ packId }: { packId: string }) {
  const qc = useQueryClient();

  const { data: pack } = useQuery({
    queryKey: ["localization-pack", packId, "country"],
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("localization_packs")
        .select("country_code")
        .eq("id", packId)
        .maybeSingle();
      return data as { country_code: string } | null;
    },
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["statutory-authorities", packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("statutory_authorities")
        .select("*")
        .eq("pack_id", packId)
        .order("code");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const [editing, setEditing] = useState<Row | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [dependents, setDependents] = useState<number>(0);

  const upsert = useMutation({
    mutationFn: async (row: Row) => {
      const payload: any = { ...row };
      if (!payload.id) delete payload.id;
      const { error } = await (supabase as any)
        .from("statutory_authorities")
        .upsert(payload, { onConflict: "id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Authority saved");
      qc.invalidateQueries({ queryKey: ["statutory-authorities", packId] });
      setEditing(null);
    },
    onError: (e) => toast.error(normalizeError(e).message ?? "Save failed"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("statutory_authorities")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Authority removed");
      qc.invalidateQueries({ queryKey: ["statutory-authorities", packId] });
      setConfirmDelete(null);
    },
    onError: (e) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  async function checkDependents(row: Row) {
    const [{ count: retCount }, { count: remCount }] = await Promise.all([
      (supabase as any)
        .from("localization_pack_return_templates")
        .select("id", { count: "exact", head: true })
        .eq("authority_id", row.id),
      (supabase as any)
        .from("localization_pack_remittance_schedules")
        .select("id", { count: "exact", head: true })
        .eq("authority_id", row.id),
    ]);
    setDependents((retCount ?? 0) + (remCount ?? 0));
    setConfirmDelete(row);
  }

  const previewProps: SpreadsheetPreviewProps = {
    title: "Statutory authorities · binding targets",
    formatLabel: `${rows.length} authorit${rows.length === 1 ? "y" : "ies"}`,
    columns: [
      { header: "Code" },
      { header: "Country" },
      { header: "Display name" },
      { header: "Portal" },
      { header: "E-filing endpoint" },
    ],
    rows: rows.map((r) => [
      r.code,
      r.country_code,
      r.display_name,
      r.portal_url ?? "—",
      r.efiling_endpoint ?? "—",
    ]),
    footnote: "Return templates and remittance schedules bind to authorities by authority_id.",
  };

  const editorContent = (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3">
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" /> Statutory authorities
        </CardTitle>
        <Button size="sm" onClick={() => setEditing(EMPTY(packId, pack?.country_code ?? ""))}>
          <Plus className="h-4 w-4 mr-1" /> New authority
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No authorities defined yet. Add the tax, pension, health and court
            regulators for this country — return templates and remittance
            schedules bind to them by <code>authority_id</code>.
          </p>
        ) : (
          <div className="divide-y">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{r.code}</span>
                    <Badge variant="secondary">{r.country_code}</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{r.display_name}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => checkDependents(r)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editing && (
        <LocalizationFormShell
          open
          onOpenChange={(v) => !v && setEditing(null)}
          entity="statutory-authority"
          mode={editing.id ? "edit" : "create"}
          title={editing.id ? `Edit ${editing.code}` : undefined}
          busy={upsert.isPending}
          onSubmit={() => upsert.mutate(editing)}
        >
          <WorkflowSheetSection title="Identity">
            <WorkflowSheetGrid>
              <WorkflowField label="Code" required>
                <Input
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                  placeholder="KRA"
                />
              </WorkflowField>
              <WorkflowField label="Country code" required>
                <Input
                  value={editing.country_code}
                  onChange={(e) => setEditing({ ...editing, country_code: e.target.value.toUpperCase() })}
                  placeholder="KE"
                  maxLength={2}
                />
              </WorkflowField>
              <WorkflowField label="Display name" required>
                <Input
                  value={editing.display_name}
                  onChange={(e) => setEditing({ ...editing, display_name: e.target.value })}
                  placeholder="Kenya Revenue Authority"
                />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection title="Submission channels">
            <WorkflowSheetGrid>
              <WorkflowField label="Portal URL">
                <Input
                  value={editing.portal_url ?? ""}
                  onChange={(e) => setEditing({ ...editing, portal_url: e.target.value || null })}
                  placeholder="https://itax.kra.go.ke"
                />
              </WorkflowField>
              <WorkflowField label="E-filing endpoint">
                <Input
                  value={editing.efiling_endpoint ?? ""}
                  onChange={(e) => setEditing({ ...editing, efiling_endpoint: e.target.value || null })}
                  placeholder="https://…/api/submit"
                />
              </WorkflowField>
            </WorkflowSheetGrid>
          </WorkflowSheetSection>

          <WorkflowSheetSection title="Contact (JSON)">
            <Textarea
              rows={4}
              value={JSON.stringify(editing.contact ?? {}, null, 2)}
              onChange={(e) => {
                try {
                  setEditing({ ...editing, contact: JSON.parse(e.target.value || "{}") });
                } catch {
                  /* ignore parse errors while typing */
                }
              }}
            />
          </WorkflowSheetSection>
        </LocalizationFormShell>
      )}

      {confirmDelete && (
        <LocalizationFormShell
          open
          onOpenChange={(v) => !v && setConfirmDelete(null)}
          entity="statutory-authority"
          mode="edit"
          title={`Delete ${confirmDelete.code}?`}
          description="This action cannot be undone."
          busy={remove.isPending}
          onSubmit={() => remove.mutate(confirmDelete.id)}
          submitLabel="Delete"
          submitDisabled={dependents > 0}
        >
          {dependents > 0 ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {dependents} template(s) or schedule(s) reference this authority.
                Reassign or delete them first.
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              This will remove <span className="font-mono">{confirmDelete.code}</span> from the pack.
            </p>
          )}
        </LocalizationFormShell>
      )}
    </Card>
    </div>
  );

  return (
    <LocalizationEntityWorkspace
      workspaceId={`statutory-authorities:${packId}`}
      kind="statutory-authority"
      templateCode={packId}
      displayName="Statutory authorities"
      preview={{ pane: "spreadsheet", props: previewProps }}
      editor={editorContent}
      statusBar={
        <div className="flex items-center gap-4">
          <span>{rows.length} authorit{rows.length === 1 ? "y" : "ies"}</span>
          <span className="ml-auto hidden md:inline text-[10px] uppercase tracking-wide text-muted-foreground/70">
            ⌘B outline · ⌘⇧P preview · ⌘⇧F focus
          </span>
        </div>
      }
    />
  );
}
