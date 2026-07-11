/**
 * OutputsCard — reusable publisher control for authoring a template's
 * `outputs` array. Renders one row per registered format in
 * `public.format_registry`, with a checkbox to include it and inputs for
 * `label` / `filename` / `role`. Both `CertificateTemplateEditor` and
 * `ReturnTemplateEditor` mount this so the two surfaces produce
 * identically-shaped `outputs jsonb`.
 *
 * Persistence contract:
 *   value === null   ⇒ publisher hasn't touched the field yet; the
 *                      generator falls back to the legacy `body.kind`
 *                      dispatch. Preserves backward compatibility with
 *                      pre-migration packs.
 *   value === []     ⇒ publisher explicitly cleared it. Treated identically
 *                      to null by the generators.
 *   value.length > 0 ⇒ authoritative list.
 */
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FileArchive } from "lucide-react";
import { usePackFormatRegistry, type PackFormat } from "../hooks/usePackFormatRegistry";

export interface OutputEntry {
  format: string;
  role?: string;
  label?: string | null;
  filename?: string | null;
}

interface Props {
  value: OutputEntry[] | null;
  onChange: (next: OutputEntry[] | null) => void;
  /** UI hint only — controls which formats surface as "typical" vs the full list. */
  surface: "certificate" | "return";
}

const CERT_TYPICAL = new Set(["pdf", "xlsx_binary"]);
const RETURN_TYPICAL = new Set(["csv", "pdf", "gov_csv", "gov_xlsx", "gov_xml"]);

export function OutputsCard({ value, onChange, surface }: Props) {
  const q = usePackFormatRegistry();
  const rows = q.data ?? [];

  const byFormat = useMemo(() => {
    const m = new Map<string, OutputEntry>();
    (value ?? []).forEach((v) => m.set(v.format, v));
    return m;
  }, [value]);

  const toggle = (fmt: PackFormat, on: boolean) => {
    const next = new Map(byFormat);
    if (on) {
      next.set(fmt.format, { format: fmt.format, role: fmt.role_hint });
    } else {
      next.delete(fmt.format);
    }
    const arr = Array.from(next.values());
    onChange(arr.length ? arr : null);
  };

  const patch = (format: string, p: Partial<OutputEntry>) => {
    const cur = byFormat.get(format);
    if (!cur) return;
    const next = Array.from(byFormat.values()).map((v) =>
      v.format === format ? { ...v, ...p } : v,
    );
    onChange(next);
  };

  const typical = surface === "certificate" ? CERT_TYPICAL : RETURN_TYPICAL;
  const primary = rows.filter((r) => typical.has(r.format));
  const advanced = rows.filter((r) => !typical.has(r.format));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <FileArchive className="h-4 w-4" />
          Outputs
          <Badge variant="outline" className="text-[10px] ml-1">
            {(value ?? []).length} selected
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[11px] text-muted-foreground">
          Every file this template emits at generation time. The generator dispatches
          one writer per checked format. Formats you don't check are simply not produced.
          Leave everything unchecked to keep the legacy single-format behaviour.
        </div>
        {q.isLoading && (
          <div className="text-xs text-muted-foreground">Loading format registry…</div>
        )}
        {[...primary, ...advanced].map((fmt) => {
          const entry = byFormat.get(fmt.format);
          const on = !!entry;
          return (
            <div key={fmt.format} className="rounded-md border p-2 space-y-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`out-${fmt.format}`}
                  checked={on}
                  onCheckedChange={(v) => toggle(fmt, !!v)}
                />
                <div className="flex-1">
                  <div className="text-xs font-medium flex items-center gap-2">
                    {fmt.label}
                    <Badge variant="outline" className="text-[10px]">{fmt.format}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{fmt.role_hint}</Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {fmt.mime} · .{fmt.ext}
                  </div>
                </div>
              </div>
              {on && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pl-6">
                  <div className="space-y-1">
                    <Label className="text-[10px]">Button label (optional)</Label>
                    <Input
                      className="h-8"
                      value={entry?.label ?? ""}
                      placeholder={fmt.label}
                      onChange={(e) => patch(fmt.format, { label: e.target.value || null })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Role</Label>
                    <Input
                      className="h-8"
                      value={entry?.role ?? fmt.role_hint}
                      onChange={(e) => patch(fmt.format, { role: e.target.value || fmt.role_hint })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Filename (optional)</Label>
                    <Input
                      className="h-8"
                      value={entry?.filename ?? ""}
                      placeholder={`<serial>.${fmt.ext}`}
                      onChange={(e) => patch(fmt.format, { filename: e.target.value || null })}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}