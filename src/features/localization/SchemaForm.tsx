/**
 * Schema-driven form for localization-pack rule parameters.
 *
 * Round 10 hardening:
 *  - Collapses JSON-Schema nullable union types like `type: ["number","null"]`
 *    into a normalized primary type + `nullable` flag so they no longer fall
 *    into the unknown-type fallback (which used to render `[object Object]`).
 *  - Each property is rendered through one of four stable field components
 *    (Primitive / Enum / Array / Object), so React never swaps element
 *    identity between renders → no focus loss on each keystroke.
 *  - Unknown shapes degrade to a friendly diagnostic (never raw JSON in an
 *    Input, never `[object Object]`).
 *  - Routes array fields to specialised `ui_schema` widgets when declared
 *    (`bracket-table`, `tier-table`).
 */
import { memo, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import { BracketTable } from "./components/widgets/BracketTable";
import { TierTable } from "./components/widgets/TierTable";

interface Props {
  schema: any;
  value: any;
  onChange: (v: any) => void;
  errors?: string[];
  path?: string;
  /** Optional ui:widget hints from `pack_rule_type_schemas.ui_schema`. */
  uiSchema?: Record<string, any> | null;
}

/** Collapse `type: ["number","null"]` style into `{ type: "number", nullable: true }`. */
export function normalizeType(schema: any): { type: string | undefined; nullable: boolean } {
  if (!schema) return { type: undefined, nullable: false };
  const raw = schema.type;
  if (Array.isArray(raw)) {
    const nonNull = raw.filter((t: string) => t !== "null");
    return { type: nonNull[0], nullable: raw.includes("null") };
  }
  return {
    type: typeof raw === "string" ? raw : undefined,
    nullable: schema.nullable === true,
  };
}

function isPrimitive(v: any) {
  return v == null || ["string", "number", "boolean"].includes(typeof v);
}

export function SchemaForm({ schema, value, onChange, errors = [], path = "$", uiSchema = null }: Props) {
  if (!schema) return <div className="text-sm text-muted-foreground">No schema available.</div>;

  const errsHere = useMemo(() => errors.filter((e) => e.startsWith(path + ":")), [errors, path]);
  const { type: t, nullable } = normalizeType(schema);

  if (schema.enum) {
    return <EnumField value={value} onChange={onChange} options={schema.enum} errors={errsHere} />;
  }

  if (t === "string") {
    return (
      <PrimitiveField
        kind="string"
        value={value}
        onChange={onChange}
        nullable={nullable}
        maxLength={schema.maxLength}
        errors={errsHere}
      />
    );
  }
  if (t === "number" || t === "integer") {
    return (
      <PrimitiveField
        kind="number"
        value={value}
        onChange={onChange}
        nullable={nullable}
        min={schema.minimum}
        max={schema.maximum}
        errors={errsHere}
      />
    );
  }
  if (t === "boolean") {
    return <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />;
  }
  if (t === "array") {
    return <ArrayField schema={schema} value={value} onChange={onChange} errors={errors} path={path} uiSchema={uiSchema} />;
  }
  if (t === "object") {
    return <ObjectField schema={schema} value={value} onChange={onChange} errors={errors} path={path} uiSchema={uiSchema} errsHere={errsHere} />;
  }

  // Truly unknown shape — never render [object Object] in an Input.
  if (isPrimitive(value)) {
    return (
      <PrimitiveField
        kind="string"
        value={value}
        onChange={onChange}
        nullable={nullable}
        errors={errsHere}
      />
    );
  }
  return (
    <Alert variant="default">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="text-xs">
        Unsupported schema shape at <code>{path}</code>. Contact the platform team.
        <details className="mt-1">
          <summary className="cursor-pointer text-muted-foreground">view value</summary>
          <pre className="text-[10px] mt-1 max-h-40 overflow-auto">{safeStringify(value)}</pre>
        </details>
      </AlertDescription>
    </Alert>
  );
}

// ── Field components ──────────────────────────────────────────────────────

const EnumField = memo(function EnumField({
  value, onChange, options, errors,
}: { value: any; onChange: (v: any) => void; options: any[]; errors: string[] }) {
  return (
    <div className="space-y-1">
      <Select value={String(value ?? "")} onValueChange={(v) => onChange(v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((opt) => <SelectItem key={String(opt)} value={String(opt)}>{String(opt)}</SelectItem>)}
        </SelectContent>
      </Select>
      {errors.map((e, i) => <p key={i} className="text-xs text-destructive">{e}</p>)}
    </div>
  );
});

const PrimitiveField = memo(function PrimitiveField({
  kind, value, onChange, nullable, min, max, maxLength, errors,
}: {
  kind: "string" | "number";
  value: any;
  onChange: (v: any) => void;
  nullable?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  errors: string[];
}) {
  const isNull = value === null;
  // Defensive: value should never be an object here, but if a caller passes
  // something weird we coerce to "" rather than render [object Object].
  const display = value == null ? "" : (typeof value === "object" ? "" : String(value));
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {kind === "number" ? (
          // NEVER disable on null. An empty/null value is a legitimate
          // editing state — disabling it traps the user the moment they
          // backspace their last character. The placeholder alone signals
          // "no value"; the optional nullable toggle below lets them
          // explicitly set null when the schema allows it.
          <NumericInput
            value={typeof value === "number" ? value : null}
            onValueChange={(n) => onChange(n)}
            placeholder={isNull ? "—" : undefined}
            min={min}
            max={max}
          />
        ) : (
          <Input
            type="text"
            value={isNull ? "" : display}
            placeholder={isNull ? "—" : undefined}
            maxLength={maxLength}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {nullable && (
          <Button
            type="button"
            size="sm"
            variant={isNull ? "secondary" : "ghost"}
            onClick={() => onChange(isNull ? (kind === "number" ? 0 : "") : null)}
            title={isNull ? "Set value" : "Set to —"}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {errors.map((e, i) => <p key={i} className="text-xs text-destructive">{e}</p>)}
    </div>
  );
});

function ArrayField({
  schema, value, onChange, errors, path, uiSchema,
}: { schema: any; value: any; onChange: (v: any) => void; errors: string[]; path: string; uiSchema: Record<string, any> | null }) {
  const items = Array.isArray(value) ? value : [];

  // Specialised widgets driven by ui_schema (bracket-table / tier-table).
  // The widget is selected by the parent ObjectField via uiSchema lookup; if
  // we land here directly with one declared on the schema itself we still
  // honour it.
  const widget = (schema as any)["ui:widget"] ?? null;
  if (widget === "bracket-table" || widget === "BandsWidget") {
    return <BracketTable value={items} onChange={onChange} itemsSchema={schema.items} />;
  }
  if (widget === "tier-table") {
    return <TierTable value={items} onChange={onChange} itemsSchema={schema.items} />;
  }

  const itemNormType = normalizeType(schema.items ?? {});
  const blankItem = () => {
    if (itemNormType.type === "object") return {};
    if (itemNormType.type === "array") return [];
    if (itemNormType.type === "number" || itemNormType.type === "integer") return 0;
    if (itemNormType.type === "boolean") return false;
    if (itemNormType.type === "string") return "";
    return null;
  };

  return (
    <div className="space-y-2">
      {items.map((it, idx) => (
        <Card key={idx}>
          <CardHeader className="flex-row items-center justify-between p-3">
            <CardTitle className="text-sm">Row {idx + 1}</CardTitle>
            <Button size="icon" variant="ghost" type="button" onClick={() => onChange(items.filter((_, i) => i !== idx))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <SchemaForm
              schema={schema.items}
              value={it}
              onChange={(nv) => onChange(items.map((x, i) => (i === idx ? nv : x)))}
              errors={errors}
              path={`${path}[${idx}]`}
              uiSchema={uiSchema}
            />
          </CardContent>
        </Card>
      ))}
      <Button variant="outline" size="sm" type="button" onClick={() => onChange([...items, blankItem()])}>
        <Plus className="h-4 w-4 mr-1" /> Add row
      </Button>
    </div>
  );
}

function ObjectField({
  schema, value, onChange, errors, path, uiSchema, errsHere,
}: { schema: any; value: any; onChange: (v: any) => void; errors: string[]; path: string; uiSchema: Record<string, any> | null; errsHere: string[] }) {
  const props = schema.properties ?? {};
  const required: string[] = schema.required ?? [];

  if (Object.keys(props).length === 0) {
    // Object with no declared properties → structured key/value editor.
    const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
    const updateEntry = (idx: number, key: string, val: string) => {
      const next: Record<string, any> = {};
      entries.forEach(([k, v], i) => {
        const nk = i === idx ? key : k;
        const nv = i === idx ? val : v;
        if (nk) next[nk] = nv;
      });
      onChange(next);
    };
    const addRow = () => onChange({ ...(value ?? {}), "": "" });
    const removeRow = (idx: number) => {
      const next: Record<string, any> = {};
      entries.forEach(([k, v], i) => { if (i !== idx) next[k] = v; });
      onChange(next);
    };
    return (
      <div className="space-y-2">
        {entries.map(([k, v], idx) => (
          <div key={idx} className="flex gap-2">
            <Input value={k} onChange={(e) => updateEntry(idx, e.target.value, String(v ?? ""))} placeholder="key" className="max-w-xs" />
            <Input value={typeof v === "object" ? "" : String(v ?? "")} onChange={(e) => updateEntry(idx, k, e.target.value)} placeholder="value" />
            <Button size="icon" variant="ghost" type="button" onClick={() => removeRow(idx)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" type="button" onClick={addRow}><Plus className="h-4 w-4 mr-1" />Add pair</Button>
        {errsHere.map((e, i) => <Alert key={i} variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{e}</AlertDescription></Alert>)}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-schema-path-prefix={path}>
      {Object.entries(props).map(([k, sub]: any) => {
        // Honour ui:widget on the parent's uiSchema or the property schema itself.
        const widget = uiSchema?.[k]?.["ui:widget"] ?? sub?.["ui:widget"] ?? null;
        const subNorm = normalizeType(sub);
        const subPath = `${path}.${k}`;
        const isRequiredMissing = required.includes(k) && (value == null || !(k in (value as object)));
        // Errors that target this exact sub-path (e.g. "$.period: required …").
        const subErrors = errors.filter((e) => e.startsWith(`${subPath}:`));
        return (
          <div key={k} className="space-y-1" data-schema-path={subPath} data-schema-path-prefix={subPath}>
            <Label className="text-xs">
              {k} {required.includes(k) && <span className="text-destructive">*</span>}
              {sub.description && <span className="text-muted-foreground ml-1 font-normal">— {sub.description}</span>}
            </Label>
            {subNorm.type === "array" && (widget === "bracket-table" || widget === "BandsWidget") ? (
              <BracketTable value={Array.isArray(value?.[k]) ? value[k] : []} onChange={(nv) => onChange({ ...(value ?? {}), [k]: nv })} itemsSchema={sub.items} />
            ) : subNorm.type === "array" && widget === "tier-table" ? (
              <TierTable value={Array.isArray(value?.[k]) ? value[k] : []} onChange={(nv) => onChange({ ...(value ?? {}), [k]: nv })} itemsSchema={sub.items} />
            ) : (
              <SchemaForm
                schema={sub}
                value={value?.[k]}
                onChange={(nv) => onChange({ ...(value ?? {}), [k]: nv })}
                errors={errors}
                path={subPath}
                uiSchema={uiSchema}
              />
            )}
            {/* Inline error rendered directly under the offending field
                so users no longer have to scan a bottom Alert to find
                what's wrong. Required-but-missing also gets a hint even
                before the validator round-trips. */}
            {subErrors.length === 0 && isRequiredMissing && (
              <p className="text-xs text-destructive">Required.</p>
            )}
            {subErrors.map((e, i) => (
              <p key={i} className="text-xs text-destructive font-mono">{e.split(":").slice(1).join(":").trim()}</p>
            ))}
          </div>
        );
      })}
      {errsHere.map((e, i) => <Alert key={i} variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{e}</AlertDescription></Alert>)}
    </div>
  );
}

function safeStringify(v: any): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
