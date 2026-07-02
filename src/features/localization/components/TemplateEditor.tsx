import { normalizeError } from "@/services/resilience";
/**
 * TemplateEditor — block-based editor for localization-pack templates.
 *
 * Each block has a business-language kind (Header / Introduction /
 * Earnings & Deductions Summary / Signature / Footer / Custom), a
 * title, and content authored with the chip-based TokenAwareTextarea.
 * The editor never mutates outside its own state until `onSave` runs
 * the server-side validator and the save succeeds.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  AlertTriangle,
  FileText,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import { TokenAwareTextarea } from "./TokenAwareTextarea";
import { validatePayload } from "../hooks";
import { PreviewPanel } from "./PreviewPanel";
import type { EditorMode } from "../types";

type Block = { id: string; kind: string; title?: string; content: string };
type TemplateBody = { blocks?: Block[]; [k: string]: any };

const BLOCK_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "header", label: "Header" },
  { value: "body", label: "Introduction" },
  { value: "totals", label: "Earnings & Deductions Summary" },
  { value: "signature", label: "Signature" },
  { value: "footer", label: "Footer" },
  { value: "custom", label: "Custom section" },
];

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  BLOCK_KIND_OPTIONS.map((o) => [o.value, o.label]),
);

// ── Starter scaffolds ──────────────────────────────────────────────
// Country-agnostic. Every concrete identifier / tax-line label comes
// from the installed localization pack via the token picker — the
// scaffold ships only structure + neutral placeholders.
const PAYSLIP_SCAFFOLD: Block[] = [
  {
    id: "header",
    kind: "header",
    title: "Header",
    content: "{{organization.name}}\nPayslip for {{run.period_label}}",
  },
  {
    id: "body",
    kind: "body",
    title: "Introduction",
    content:
      "Employee: {{employee.full_name}} ({{employee.employee_number}})\nPay period: {{run.period_start}} – {{run.period_end}}",
  },
  {
    id: "totals",
    kind: "totals",
    title: "Earnings & Deductions Summary",
    content:
      "Basic pay: {{contract.currency}} {{contract.basic_salary}} / {{contract.payment_frequency}}\nGross pay: {{contract.currency}} {{run.gross_pay}}\nNet pay: {{contract.currency}} {{run.net_pay}}\n\n(Insert pack-specific statutory deductions from the token picker.)",
  },
  {
    id: "signature",
    kind: "signature",
    title: "Signature",
    content: "Authorised by {{organization.name}} · Generated {{system.now}}",
  },
];

const CERTIFICATE_SCAFFOLD: Block[] = [
  {
    id: "header",
    kind: "header",
    title: "Header",
    content: "{{organization.name}}\nTax Deduction Certificate — {{system.tax_year}}",
  },
  {
    id: "body",
    kind: "body",
    title: "Introduction",
    content:
      "This is to certify that {{employee.full_name}} (Employee No. {{employee.employee_number}}) was employed by {{organization.name}} during the tax year ending {{system.tax_year}}.",
  },
  {
    id: "totals",
    kind: "totals",
    title: "Earnings & Deductions Summary",
    content:
      "Taxable income: {{contract.currency}} {{run.taxable_pay}}\nEmployer contributions: {{contract.currency}} {{run.employer_contributions_total}}\n\n(Insert pack-specific tax / contribution totals from the token picker.)",
  },
  {
    id: "signature",
    kind: "signature",
    title: "Signature",
    content:
      "Issued on {{system.now}} by {{organization.name}}\n{{organization.address}} · {{organization.phone}}",
  },
];

const EMPTY_SCAFFOLD: Block[] = [
  { id: "header", kind: "header", title: "Header", content: "" },
  { id: "body", kind: "body", title: "Introduction", content: "" },
  { id: "totals", kind: "totals", title: "Earnings & Deductions Summary", content: "" },
  { id: "signature", kind: "signature", title: "Signature", content: "" },
];

function pickScaffold(templateCode: string): Block[] {
  const code = templateCode.toLowerCase();
  if (/^(payslip|pay_advice|wage_slip)/.test(code)) return PAYSLIP_SCAFFOLD;
  // Generic year-end certificate detector — no country codes. Pack publishers
  // can name their cert templates `tax_certificate` / `withholding_cert` /
  // anything containing `certificate`; we still pick the cert scaffold.
  if (/(tax_certificate|withholding_cert|certificate)/.test(code)) return CERTIFICATE_SCAFFOLD;
  return EMPTY_SCAFFOLD;
}

function hasMeaningfulContent(body: any): boolean {
  if (!body) return false;
  if (typeof body === "string") return body.trim().length > 0;
  if (Array.isArray(body.blocks)) {
    return (body.blocks as Block[]).some(
      (b) => typeof b.content === "string" && b.content.trim().length > 0,
    );
  }
  if (typeof body === "object") {
    return Object.values(body).some((v) => typeof v === "string" && (v as string).trim().length > 0);
  }
  return false;
}

function normalizeBody(body: any, templateCode: string): TemplateBody {
  if (body && Array.isArray(body.blocks) && body.blocks.length > 0) return body;
  if (typeof body === "string" && body.trim().length > 0) {
    return { blocks: [{ id: "body", kind: "body", title: "Introduction", content: body }] };
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const inferred = Object.entries(body)
      .filter(([, v]) => typeof v === "string" && (v as string).trim().length > 0)
      .map(([k, v]) => ({
        id: k,
        kind: KIND_LABEL[k] ? k : "custom",
        title: KIND_LABEL[k] ?? k,
        content: v as string,
      }));
    if (inferred.length) return { ...body, blocks: inferred };
  }
  // Fresh template → apply a code-aware scaffold
  return { blocks: pickScaffold(templateCode).map((b) => ({ ...b })) };
}

function describeRecipient(templateCode: string): string {
  const c = templateCode.toLowerCase();
  if (/^(payslip|pay_advice|wage_slip)/.test(c))
    return "Issued to employees each pay run.";
  if (/(tax_certificate|withholding_cert|certificate)/.test(c))
    return "Issued to employees and tax authorities at year-end.";
  if (/(return|filing|remittance)/.test(c))
    return "Submitted to the statutory authority for the reporting period.";
  return "Issued from this localization pack.";
}

interface Props {
  mode: EditorMode;
  packId?: string | null;
  templateCode: string;
  initial: { template_code: string; body: any; layout?: string | null; notes?: string | null };
  onSave: (next: { body: TemplateBody; layout: string | null; notes: string | null }) => Promise<void> | void;
  onCancel?: () => void;
  /**
   * Optional live-body callback. When provided, the editor emits every
   * body mutation so an outer shell (e.g. CertificateTemplateEditor's
   * field inspector) can render diagnostics against the working copy.
   * Purely observational — the editor keeps ownership of the state.
   */
  onBodyChange?: (body: TemplateBody) => void;
  /**
   * Optional pre-save gate. When provided and returns false, the save
   * is aborted (the outer shell is responsible for surfacing why).
   */
  canSave?: () => boolean;
}

export function TemplateEditor({ mode, packId, templateCode, initial, onSave, onCancel, onBodyChange, canSave }: Props) {
  const [body, setBody] = useState<TemplateBody>(() => normalizeBody(initial.body, templateCode));
  const [layout, setLayout] = useState(initial.layout ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeBlockId, setActiveBlockId] = useState<string>(body.blocks?.[0]?.id ?? "body");

  // Notify outer shells of body changes for live-inspector rendering.
  useEffect(() => {
    onBodyChange?.(body);
  }, [JSON.stringify(body)]);

  const blocks = body.blocks ?? [];
  const activeBlock = blocks.find((b) => b.id === activeBlockId) ?? blocks[0];

  const recipientLine = useMemo(() => describeRecipient(templateCode), [templateCode]);
  const wasScaffoldApplied = !hasMeaningfulContent(initial.body);

  const updateBlock = (id: string, patch: Partial<Block>) => {
    setBody((prev) => ({
      ...prev,
      blocks: (prev.blocks ?? []).map((b) => (b.id === id ? { ...b, ...patch } : b)),
    }));
  };

  const addBlock = (kind: string) => {
    const id = `block_${Date.now()}`;
    setBody((prev) => ({
      ...prev,
      blocks: [
        ...(prev.blocks ?? []),
        { id, kind, title: KIND_LABEL[kind] ?? "New section", content: "" },
      ],
    }));
    setActiveBlockId(id);
  };

  const removeBlock = (id: string) => {
    setBody((prev) => {
      const next = (prev.blocks ?? []).filter((b) => b.id !== id);
      return { ...prev, blocks: next };
    });
    if (activeBlockId === id) {
      const remaining = (body.blocks ?? []).filter((b) => b.id !== id);
      if (remaining.length) setActiveBlockId(remaining[0].id);
    }
  };

  const moveBlock = (id: string, dir: -1 | 1) => {
    setBody((prev) => {
      const list = [...(prev.blocks ?? [])];
      const i = list.findIndex((b) => b.id === id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= list.length) return prev;
      [list[i], list[j]] = [list[j], list[i]];
      return { ...prev, blocks: list };
    });
  };

  // Live validation against the server (debounced).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await validatePayload({ kind: "template", pack_id: packId ?? null, body });
        if (!cancelled) {
          setErrors(r.errors);
          setWarnings(r.warnings);
        }
      } catch {
        /* ignore live errors */
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [JSON.stringify(body), packId]);

  const handleSave = async () => {
    if (canSave && !canSave()) {
      toast.error("Resolve template issues before saving");
      return;
    }
    setBusy(true);
    try {
      const r = await validatePayload({ kind: "template", pack_id: packId ?? null, body });
      if (!r.valid) {
        setErrors(r.errors);
        setWarnings(r.warnings);
        toast.error("Fix template errors before saving");
        return;
      }
      await onSave({ body, layout: layout || null, notes: notes || null });
      toast.success("Template saved");
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {mode === "admin" ? "Pack template" : "Tenant template override"} — {templateCode}
        </CardTitle>
        <div className="text-xs text-muted-foreground">{recipientLine}</div>
        {wasScaffoldApplied && (
          <div className="text-[11px] text-muted-foreground">
            Starter content was applied — edit each section to match your statutory requirements.
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={activeBlockId} onValueChange={setActiveBlockId}>
          <div className="flex items-center gap-2 flex-wrap">
            <TabsList className="flex-wrap h-auto">
              {blocks.map((b) => (
                <TabsTrigger key={b.id} value={b.id} className="text-xs">
                  {b.title ?? KIND_LABEL[b.kind] ?? "Section"}
                </TabsTrigger>
              ))}
            </TabsList>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Plus className="h-3 w-3 mr-1" />Add section
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {BLOCK_KIND_OPTIONS.map((opt) => (
                  <DropdownMenuItem key={opt.value} onClick={() => addBlock(opt.value)}>
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {blocks.map((b, idx) => (
            <TabsContent key={b.id} value={b.id} className="space-y-2 pt-3">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Section title
                  </Label>
                  <Input
                    value={b.title ?? ""}
                    onChange={(e) => updateBlock(b.id, { title: e.target.value })}
                    className="max-w-xs h-8"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Section kind
                  </Label>
                  <Select value={b.kind} onValueChange={(v) => updateBlock(b.id, { kind: v })}>
                    <SelectTrigger className="h-8 w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BLOCK_KIND_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-1 ml-auto">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={idx === 0}
                    onClick={() => moveBlock(b.id, -1)}
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={idx === blocks.length - 1}
                    onClick={() => moveBlock(b.id, 1)}
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  {blocks.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeBlock(b.id)}
                      title="Remove section"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />Remove
                    </Button>
                  )}
                </div>
              </div>
              <TokenAwareTextarea
                id={`tpl-block-${b.id}`}
                packId={packId ?? null}
                rows={10}
                value={b.content}
                onChange={(next) => updateBlock(b.id, { content: next })}
              />
            </TabsContent>
          ))}
        </Tabs>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Layout</Label>
            <Input value={layout} onChange={(e) => setLayout(e.target.value)} placeholder="default" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Notes (audit reason)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Required for tenant overrides"
            />
          </div>
        </div>

        {warnings.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </AlertDescription>
          </Alert>
        )}
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {errors.map((e, i) => (
                <div key={i} className="text-xs">
                  {e}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        )}

        <PreviewPanel body={body} packId={packId ?? null} title="Document preview" />

        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button onClick={handleSave} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save template
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
