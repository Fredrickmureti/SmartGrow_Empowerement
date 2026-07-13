/**
 * ThemeInspector — pack-owned Theme editor for the certificate studio.
 *
 * Renders every `Theme` token (types.ts) as a labelled control and pushes
 * changes back through `onChange`. Living in the toolbar as a popover so
 * publishers can tune presentation without leaving the canvas. All tokens
 * are optional — omitted fields fall back to `ENGINE_DEFAULT_THEME` at
 * compile time.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RotateCcw } from "lucide-react";
import type { Theme } from "../lib/engine/types";

interface Props {
  value: Theme | undefined | null;
  onChange: (next: Theme) => void;
}

type Field = keyof Theme;
const set = <K extends Field>(t: Theme, k: K, v: Theme[K]): Theme => {
  const next = { ...(t ?? {}) } as Theme;
  if (v === undefined || v === "" || v === null) delete (next as any)[k];
  else (next as any)[k] = v;
  return next;
};

function ColorField({ label, val, onChange, placeholder }: { label: string; val?: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="color"
          value={val && /^#[0-9a-fA-F]{6}$/.test(val) ? val : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 shrink-0 p-0.5"
        />
        <Input
          value={val ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "inherit"}
          className="h-7 flex-1 font-mono text-xs"
        />
      </div>
    </div>
  );
}

function NumberField({ label, val, onChange, step = 0.25, min, max, suffix }: { label: string; val?: number; onChange: (v: number | undefined) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}{suffix ? ` (${suffix})` : ""}</Label>
      <Input
        type="number"
        value={val ?? ""}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
        className="h-7 text-xs"
        placeholder="default"
      />
    </div>
  );
}

export function ThemeInspector({ value, onChange }: Props) {
  const t: Theme = value ?? {};
  const patch = <K extends Field>(k: K, v: Theme[K]) => onChange(set(t, k, v));

  return (
    <div className="w-[380px]">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Theme</div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-[11px]"
          onClick={() => onChange({})}
          title="Reset all tokens to engine defaults"
        >
          <RotateCcw className="h-3 w-3" /> Reset
        </Button>
      </div>
      <ScrollArea className="max-h-[70vh]">
        <div className="space-y-4 p-3">
          {/* Typography */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Typography</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1 col-span-2">
                <Label className="text-[11px]">Body font</Label>
                <Input value={t.body_font ?? ""} onChange={(e) => patch("body_font", e.target.value)} placeholder='e.g. "Times New Roman", serif' className="h-7 text-xs" />
              </div>
              <div className="space-y-1 col-span-2">
                <Label className="text-[11px]">Heading font</Label>
                <Input value={t.heading_font ?? ""} onChange={(e) => patch("heading_font", e.target.value)} placeholder="inherits body font" className="h-7 text-xs" />
              </div>
              <NumberField label="Base size" suffix="pt" val={t.base_font_size_pt} onChange={(v) => patch("base_font_size_pt", v)} step={0.5} min={6} max={16} />
              <div className="space-y-1">
                <Label className="text-[11px]">Numeric spacing</Label>
                <Input value={t.numeric_letter_spacing ?? ""} onChange={(e) => patch("numeric_letter_spacing", e.target.value)} placeholder="e.g. 0.02em" className="h-7 text-xs" />
              </div>
            </div>
          </section>

          {/* Colours */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Colours</div>
            <div className="grid grid-cols-2 gap-2">
              <ColorField label="Text" val={t.color} onChange={(v) => patch("color", v)} />
              <ColorField label="Muted text" val={t.muted_color} onChange={(v) => patch("muted_color", v)} />
              <ColorField label="Rule" val={t.rule_color} onChange={(v) => patch("rule_color", v)} />
              <NumberField label="Rule weight" suffix="pt" val={t.rule_weight_pt} onChange={(v) => patch("rule_weight_pt", v)} step={0.1} min={0} max={4} />
            </div>
          </section>

          {/* Grid header shading */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Grid header shading</div>
            <div className="grid grid-cols-2 gap-2">
              <ColorField label="Header" val={t.header_shade === "none" ? "" : t.header_shade} onChange={(v) => patch("header_shade", v || undefined)} placeholder="none" />
              <ColorField label="Letter row" val={t.header_letter_shade === "none" ? "" : t.header_letter_shade} onChange={(v) => patch("header_letter_shade", v || undefined)} placeholder="none" />
              <ColorField label="Unit row" val={t.header_unit_shade === "none" ? "" : t.header_unit_shade} onChange={(v) => patch("header_unit_shade", v || undefined)} placeholder="none" />
              <ColorField label="Note row" val={t.header_note_shade === "none" ? "" : t.header_note_shade} onChange={(v) => patch("header_note_shade", v || undefined)} placeholder="none" />
            </div>
          </section>

          {/* Grid zebra + density */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Grid rows</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Zebra</Label>
                <Select value={t.zebra ?? "none"} onValueChange={(v) => patch("zebra", v as any)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="even">Even rows</SelectItem>
                    <SelectItem value="odd">Odd rows</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <ColorField label="Zebra colour" val={t.zebra_color} onChange={(v) => patch("zebra_color", v)} />
              <NumberField label="Row font" suffix="pt" val={t.grid_font_size_pt} onChange={(v) => patch("grid_font_size_pt", v)} step={0.25} min={5} max={14} />
              <NumberField label="Number font" suffix="pt" val={t.grid_number_font_size_pt} onChange={(v) => patch("grid_number_font_size_pt", v)} step={0.25} min={5} max={14} />
              <NumberField label="Footer font" suffix="pt" val={t.grid_footer_font_size_pt} onChange={(v) => patch("grid_footer_font_size_pt", v)} step={0.25} min={5} max={14} />
            </div>
          </section>

          {/* Headings */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Headings</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Case</Label>
                <Select value={t.heading_case ?? "none"} onValueChange={(v) => patch("heading_case", v as any)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">As typed</SelectItem>
                    <SelectItem value="upper">UPPERCASE</SelectItem>
                    <SelectItem value="capitalize">Capitalize</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-1">
                <Switch checked={!!t.heading_underline} onCheckedChange={(v) => patch("heading_underline", !!v)} />
                <Label className="text-[11px]">Underline</Label>
              </div>
            </div>
          </section>

          {/* Legal notice */}
          <section className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Legal notice</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-end gap-2 pb-1">
                <Switch checked={!!t.legal_border} onCheckedChange={(v) => patch("legal_border", !!v)} />
                <Label className="text-[11px]">Show border</Label>
              </div>
              <ColorField label="Border colour" val={t.legal_border_color} onChange={(v) => patch("legal_border_color", v)} />
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
