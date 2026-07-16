import { normalizeError } from "@/services/resilience";
/**
 * Settings → Payroll → Templates (Stage C).
 *
 * Lets payroll managers customize localization-pack tax-certificate and
 * statutory-return templates per business without forking the pack. Each
 * row shows: pack default / customized vN / out-of-date. Edits require a
 * ≥10-char reason and write a row to audit_logs via DB trigger.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkflowSheet } from "@/components/workflow/WorkflowSheet";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Loader2, Pencil, RotateCcw, AlertTriangle } from "lucide-react";
import { ReturnTemplateEditor } from "@/features/localization";
import { useCertificateTemplates } from "@/hooks/payroll/useTaxCertificates";
import { useReturnTemplates } from "@/hooks/payroll/useStatutoryReturns";
import {
  useTemplateOverrides,
  useSaveTemplateOverride,
  useResetTemplateOverride,
  type TemplateOverride,
} from "@/hooks/payroll/useTemplateOverrides";

type Kind = "certificate" | "return";

interface PackRow {
  id: string;
  pack_id: string | null;
  code: string;
  display_name: string;
  description: string | null;
  body: any;
  layout?: string;
  updated_at?: string;
}

export default function PayrollTemplates() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Payroll templates</h1>
        <p className="text-muted-foreground text-sm">
          Customize statutory return and tax-certificate templates for this business. Pack
          defaults are restored when an override is reset. All changes are audit-logged.
        </p>
      </div>

      <Tabs defaultValue="certificate" className="space-y-4">
        <TabsList>
          <TabsTrigger value="certificate">Tax certificates</TabsTrigger>
          <TabsTrigger value="return">Statutory returns</TabsTrigger>
        </TabsList>

        <TabsContent value="certificate"><TemplatesPanel kind="certificate" /></TabsContent>
        <TabsContent value="return"><TemplatesPanel kind="return" /></TabsContent>
      </Tabs>
    </div>
  );
}

function TemplatesPanel({ kind }: { kind: Kind }) {
  const navigate = useNavigate();
  const certQ = useCertificateTemplates();
  const retQ = useReturnTemplates();
  const overridesQ = useTemplateOverrides(kind);

  const packs: PackRow[] = (kind === "certificate" ? certQ.data : retQ.data) ?? [];
  const overrides = overridesQ.data ?? [];
  const overrideByCode = useMemo(() => {
    const m = new Map<string, TemplateOverride>();
    for (const o of overrides) m.set(o.template_code, o);
    return m;
  }, [overrides]);

  const [editing, setEditing] = useState<PackRow | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  const isLoading = (kind === "certificate" ? certQ.isLoading : retQ.isLoading) || overridesQ.isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{kind === "certificate" ? "Tax certificate templates" : "Statutory return templates"}</CardTitle>
        <CardDescription>
          Click <strong>Override</strong> to customize the template for this business with a
          structured editor — no JSON. Click <strong>Reset</strong> to drop the override and fall
          back to the pack default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center p-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !packs.length ? (
          <p className="text-muted-foreground text-sm">No templates available — install a localization pack first.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {packs.map((p) => {
                const ov = overrideByCode.get(p.code);
                const stale =
                  ov?.base_template_updated_at &&
                  p.updated_at &&
                  new Date(ov.base_template_updated_at).getTime() !== new Date(p.updated_at).getTime();
                // Slice-C: enumerate which operational columns the tenant has
                // diverged on, so the operator sees drift at discovery time
                // instead of waiting for the edge function to surprise them.
                const opOverridden: string[] = [];
                if (ov && kind === "return") {
                  for (const k of [
                    "submission_channel",
                    "submission_format",
                    "output",
                    "due_day",
                    "due_month_offset",
                  ] as const) {
                    if ((ov as any)[k] != null) opOverridden.push(k);
                  }
                }
                return (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">{p.code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{p.display_name}</div>
                      {p.description && <div className="text-muted-foreground text-xs">{p.description}</div>}
                    </TableCell>
                    <TableCell>
                      {!ov ? (
                        <Badge variant="secondary">Pack default</Badge>
                      ) : stale ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" /> Out of date · v{ov.override_version}
                        </Badge>
                      ) : (
                        <Badge>Customized · v{ov.override_version}</Badge>
                      )}
                      {opOverridden.length > 0 && (
                        <div className="text-muted-foreground mt-1 text-[10px] uppercase tracking-wide">
                          operational: {opOverridden.join(", ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          kind === "certificate"
                            ? navigate(`/hr/payroll/configuration/templates/certificates/${encodeURIComponent(p.code)}/edit`)
                            : setEditing(p)
                        }
                      >
                        <Pencil className="h-3 w-3 mr-1" />
                        {ov ? "Edit override" : "Override"}
                      </Button>
                      {ov && (
                        <Button size="sm" variant="ghost" onClick={() => setResetting(p.code)}>
                          <RotateCcw className="h-3 w-3 mr-1" /> Reset
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {editing && (
        <OverrideEditor
          kind={kind}
          pack={editing}
          existing={overrideByCode.get(editing.code) ?? null}
          onClose={() => setEditing(null)}
        />
      )}

      <ResetConfirm kind={kind} code={resetting} onClose={() => setResetting(null)} />
    </Card>
  );
}

function OverrideEditor({
  kind,
  pack,
  existing,
  onClose,
}: {
  kind: Kind;
  pack: PackRow;
  existing: TemplateOverride | null;
  onClose: () => void;
}) {
  const save = useSaveTemplateOverride(kind);

  const handleSave = async ({ body, layout, notes }: { body: any; layout: string | null; notes: string | null }) => {
    const reason = (notes ?? "").trim();
    if (reason.length < 10) {
      toast.error("Reason (notes) must be at least 10 characters — used for the audit log.");
      throw new Error("Reason too short");
    }
    try {
      await save.mutateAsync({
        template_code: pack.code,
        body,
        layout: kind === "certificate" ? layout : null,
        notes: reason,
        base_pack_id: pack.pack_id,
        base_template_updated_at: pack.updated_at!,
      });
      toast.success("Override saved");
      onClose();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to save override");
      throw e;
    }
  };

  return (
    <WorkflowSheet
      open
      onOpenChange={(o) => !o && onClose()}
      size="2xl"
      title={`${existing ? "Edit override" : "Create override"} — ${pack.display_name}`}
      description={
        kind === "return"
          ? "Edit filters, columns, group-by and totals for this statutory return. The runtime reads exactly these fields — no JSON. Saved overrides apply to this business only; the pack template stays untouched."
          : "Edit the certificate content as named blocks (header / body / totals / signature / custom). Use Insert token to reference employee, run or organization data — the preview shows exactly what will render. Saved overrides apply to this business only; the pack template stays untouched."
      }
    >
      {kind === "return" ? (
        <ReturnTemplateEditor
          mode="tenant"
          packId={pack.pack_id}
          templateCode={pack.code}
          initial={{
            template_code: pack.code,
            body: existing?.body ?? pack.body,
            layout: null,
            notes: existing?.notes ?? "",
          }}
          onSave={handleSave}
          onCancel={onClose}
        />
      ) : (
        // Certificate tenant overrides are handled via full-page navigation
        // to `PayrollCertificateTemplateEdit` (see TemplatesPanel row action).
        // This branch is unreachable — retained as a defensive no-op to keep
        // OverrideEditor total for the union of Kind values.
        null
      )}
    </WorkflowSheet>
  );
}


function ResetConfirm({ kind, code, onClose }: { kind: Kind; code: string | null; onClose: () => void }) {
  const reset = useResetTemplateOverride(kind);
  const onConfirm = async () => {
    if (!code) return;
    try {
      await reset.mutateAsync(code);
      toast.success("Override removed — pack default restored");
      onClose();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Failed to reset");
    }
  };
  return (
    <AlertDialog open={!!code} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset override?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes your customization for <code>{code}</code> and restores the pack default
            for this business. Existing certificates already issued are unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Reset to default</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
