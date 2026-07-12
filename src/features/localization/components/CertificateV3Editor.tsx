/**
 * CertificateV3Editor — publisher-facing surface for Certificate Engine v3
 * templates (schema_version: 3, country-agnostic AST). Mounted from
 * CertificateTemplateEditor when the publisher flips the schema toggle to
 * "Engine AST v3".
 *
 * Scope of this first iteration:
 *   • Structured form for `paper_format` (size, orientation, margins,
 *     header/footer bands).
 *   • JSON authoring surfaces for `page_master.header/footer` and the
 *     top-level `document` node array, with schema-checked live parse.
 *   • Client-side mirror of the two DB validators
 *     (`enforce_certificate_template_structure`,
 *      `assert_certificate_template_body_valid` computation_kind='v3')
 *     so save is blocked on the same rules the server enforces at write
 *     time. Chip list of missing invariants (identity_strip, matrix,
 *     signature_strip) mirrors the section completeness card used by v1/v2.
 *   • "Seed from Kenya P9 v10" convenience button for publishers starting
 *     a new pack — copies the canonical KE_P9 v3 AST as the starting body.
 *
 * A drag-and-drop visual canvas and browser-side engine preview are the
 * next iteration (deferred with the AST producer's browser bundle). The
 * JSON surfaces here are intentional: the AST is small, human-readable,
 * and publishers who need v3 today are the same regulators/consultants
 * who already read the AST spec.
 */
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, FileCode2, Sparkles } from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────

export type PaperSize = "A4" | "A3" | "Letter" | "Legal";
export type Orientation = "portrait" | "landscape";

export interface PaperFormat {
  size: PaperSize;
  orientation: Orientation;
  margin_top: number;
  margin_right: number;
  margin_bottom: number;
  margin_left: number;
  header_height: number;
  footer_height: number;
}

export interface V3Body {
  schema_version: 3;
  code?: string;
  display_name?: string;
  paper_format: PaperFormat;
  page_master?: {
    code?: string;
    header?: unknown[];
    footer?: unknown[];
  };
  document: unknown[];
}

export function defaultV3Body(templateCode: string): V3Body {
  return {
    schema_version: 3,
    code: templateCode,
    paper_format: {
      size: "A4",
      orientation: "portrait",
      margin_top: 12,
      margin_right: 12,
      margin_bottom: 12,
      margin_left: 12,
      header_height: 14,
      footer_height: 10,
    },
    page_master: { code: `${templateCode.toLowerCase()}.page_master.v1`, header: [], footer: [] },
    document: [],
  };
}

// Canonical KE P9 v10 seed. Kept in sync with the pack row shipped by
// migration 20260712* / pack_versions 10.1.0. Publishers starting a new
// pack copy this then edit — the same body validators run on save.
function keP9SeedBody(): V3Body {
  return {
    schema_version: 3,
    code: "KE_P9_2025",
    display_name: "Kenya — Tax Deduction Card (P9)",
    paper_format: {
      size: "A4", orientation: "landscape",
      margin_top: 12, margin_right: 10, margin_bottom: 12, margin_left: 10,
      header_height: 14, footer_height: 10,
    },
    page_master: {
      code: "ke.p9.page_master.v10",
      header: [
        { type: "heading", level: 1, align: "center",
          text: { kind: "literal", value: "KENYA REVENUE AUTHORITY — DOMESTIC TAXES DEPARTMENT" } },
        { type: "heading", level: 2, align: "center",
          text: { kind: "literal", value: "TAX DEDUCTION CARD" } },
      ],
      footer: [],
    },
    document: [
      { type: "identity_strip",
        left_title:  { kind: "literal", value: "Employer" },
        right_title: { kind: "literal", value: "Employee" },
        left:  [{ type: "key_value", label: { kind: "literal", value: "Name" }, value: { kind: "binding", path: "employer.name", fallback: "" } }],
        right: [{ type: "key_value", label: { kind: "literal", value: "Name" }, value: { kind: "binding", path: "employee.full_name", fallback: "" } }],
      },
      { type: "matrix",
        rows_binding: "p9.months",
        columns: [
          { key: "month", header: { kind: "literal", value: "Month" }, align: "left",  format: "month_short" },
          { key: "col_o", header: { kind: "literal", value: "PAYE" }, align: "right", format: "number" },
        ],
      },
      { type: "signature_strip",
        slots: [
          { caption: { kind: "literal", value: "Employer Signature" } },
          { caption: { kind: "literal", value: "Employee Declaration" } },
        ],
      },
    ],
  };
}

// ── Client-side mirror of the DB validators ─────────────────────────────

export interface V3Validation {
  ok: boolean;
  missing: string[];      // human-readable missing invariants
  parseErrors: string[];  // JSON parse errors on user-authored fields
}

function validateV3Body(body: Partial<V3Body>, parseErrors: string[]): V3Validation {
  const missing: string[] = [];
  if (!body.paper_format) missing.push("paper_format");
  const doc = Array.isArray(body.document) ? body.document : [];
  if (doc.length === 0) missing.push("non-empty document");
  const hasType = (t: string) =>
    doc.some((n: any) => n && typeof n === "object" && n.type === t);
  if (!hasType("identity_strip"))  missing.push("identity_strip node");
  if (!hasType("signature_strip")) missing.push("signature_strip node");
  if (!hasType("matrix"))          missing.push("matrix node");
  return { ok: missing.length === 0 && parseErrors.length === 0, missing, parseErrors };
}

// ── Component ───────────────────────────────────────────────────────────

interface Props {
  templateCode: string;
  body: V3Body;
  onChange: (next: V3Body) => void;
  /** Called with the current validation on every change so the parent can
   *  gate the Save button on the same rules the server enforces. */
  onValidityChange?: (v: V3Validation) => void;
}

export function CertificateV3Editor({ templateCode, body, onChange, onValidityChange }: Props) {
  const paper = body.paper_format;

  // Document + page_master are edited as JSON. We keep the parsed value in
  // the body and surface parse errors so the publisher can't save invalid
  // JSON (the server would reject it anyway).
  const documentJson = useMemo(() => JSON.stringify(body.document ?? [], null, 2), [body.document]);
  const headerJson   = useMemo(() => JSON.stringify(body.page_master?.header ?? [], null, 2), [body.page_master?.header]);
  const footerJson   = useMemo(() => JSON.stringify(body.page_master?.footer ?? [], null, 2), [body.page_master?.footer]);

  const parseErrors: string[] = [];

  const patchPaper = (patch: Partial<PaperFormat>) =>
    onChange({ ...body, paper_format: { ...paper, ...patch } });

  const patchDocumentJson = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("document must be a JSON array");
      onChange({ ...body, document: parsed });
    } catch (e: any) {
      parseErrors.push(`document: ${e?.message ?? "invalid JSON"}`);
      // still surface — validation will block save
      onValidityChange?.(validateV3Body(body, [`document: ${e?.message ?? "invalid JSON"}`]));
    }
  };
  const patchBand = (band: "header" | "footer", raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
      onChange({
        ...body,
        page_master: { ...(body.page_master ?? { code: `${templateCode.toLowerCase()}.page_master.v1` }), [band]: parsed },
      });
    } catch (e: any) {
      parseErrors.push(`page_master.${band}: ${e?.message ?? "invalid JSON"}`);
      onValidityChange?.(validateV3Body(body, [`page_master.${band}: ${e?.message ?? "invalid JSON"}`]));
    }
  };

  const validation = useMemo(() => {
    const v = validateV3Body(body, parseErrors);
    onValidityChange?.(v);
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const seedFromKeP9 = () => onChange(keP9SeedBody());

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileCode2 className="h-4 w-4" /> Paper format
          </CardTitle>
          <Button type="button" size="sm" variant="outline" onClick={seedFromKeP9}>
            <Sparkles className="h-3.5 w-3.5 mr-1" /> Seed from Kenya P9 v10
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Size</Label>
            <Select value={paper.size} onValueChange={(v) => patchPaper({ size: v as PaperSize })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="A4">A4</SelectItem>
                <SelectItem value="A3">A3</SelectItem>
                <SelectItem value="Letter">Letter</SelectItem>
                <SelectItem value="Legal">Legal</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Orientation</Label>
            <Select value={paper.orientation} onValueChange={(v) => patchPaper({ orientation: v as Orientation })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="portrait">Portrait</SelectItem>
                <SelectItem value="landscape">Landscape</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <MmField label="Margin top"    value={paper.margin_top}    onChange={(n) => patchPaper({ margin_top: n })} />
          <MmField label="Margin right"  value={paper.margin_right}  onChange={(n) => patchPaper({ margin_right: n })} />
          <MmField label="Margin bottom" value={paper.margin_bottom} onChange={(n) => patchPaper({ margin_bottom: n })} />
          <MmField label="Margin left"   value={paper.margin_left}   onChange={(n) => patchPaper({ margin_left: n })} />
          <MmField label="Header band"   value={paper.header_height} onChange={(n) => patchPaper({ header_height: n })} />
          <MmField label="Footer band"   value={paper.footer_height} onChange={(n) => patchPaper({ footer_height: n })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Page master</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Header band (repeats on every page) — JSON array of nodes</Label>
            <Textarea
              className="font-mono text-[11px]"
              rows={8}
              defaultValue={headerJson}
              onBlur={(e) => patchBand("header", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Footer band (repeats on every page) — JSON array of nodes</Label>
            <Textarea
              className="font-mono text-[11px]"
              rows={6}
              defaultValue={footerJson}
              onBlur={(e) => patchBand("footer", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Document nodes</CardTitle>
          <div className="flex flex-wrap gap-1">
            {["identity_strip", "matrix", "signature_strip"].map((t) => {
              const present = Array.isArray(body.document)
                && body.document.some((n: any) => n?.type === t);
              return (
                <Badge key={t} variant={present ? "outline" : "destructive"} className="text-[10px]">
                  {present ? "✓" : "missing"} {t}
                </Badge>
              );
            })}
          </div>
        </CardHeader>
        <CardContent>
          <Label className="text-xs">Top-level document — JSON array of nodes</Label>
          <Textarea
            className="font-mono text-[11px] mt-1"
            rows={20}
            defaultValue={documentJson}
            onBlur={(e) => patchDocumentJson(e.target.value)}
          />
          <div className="text-[10px] text-muted-foreground mt-2">
            Every node must have a <code>type</code>. Values are either
            <code>{" { kind: 'literal', value } "}</code> or
            <code>{" { kind: 'binding', path, format?, fallback? } "}</code>.
            Statutory bodies require an <code>identity_strip</code>, at least
            one <code>matrix</code>, and a <code>signature_strip</code>.
          </div>
        </CardContent>
      </Card>

      {(!validation.ok) && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>v3 body is not saveable yet</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5 text-xs">
              {validation.missing.map((m) => <li key={m}>Missing: {m}</li>)}
              {validation.parseErrors.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function MmField({
  label, value, onChange,
}: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label} (mm)</Label>
      <Input
        type="number"
        min={0}
        step={1}
        className="h-8"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </div>
  );
}

export { validateV3Body };