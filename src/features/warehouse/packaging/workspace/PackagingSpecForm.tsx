/**
 * Packaging specification editor — the "single record" side of the master.
 *
 * The form is a pure projection of the RPC payload contract; it never
 * touches the table directly. Concurrency is carried by `row_version`.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Section } from "@/design-system";
import {
  PACKAGING_CLASSES,
  packagingErrorMessage,
  useUpsertPackaging,
  usableVolumeCm3,
  dimWeightKg,
  type PackagingClass,
  type PackagingType,
  type PackagingUpsertPayload,
} from "../packagingMaster";

interface Props {
  businessId?: string;
  record: PackagingType | null;
  readOnly?: boolean;
  onSaved: (row: PackagingType) => void;
  onCancel?: () => void;
}

type FormState = {
  code: string;
  name: string;
  packaging_class: PackagingClass;
  material: string;
  inner_length_cm: string;
  inner_width_cm: string;
  inner_height_cm: string;
  outer_length_cm: string;
  outer_width_cm: string;
  outer_height_cm: string;
  max_weight_kg: string;
  tare_weight_kg: string;
  max_volume_fill_pct: string;
  dim_weight_divisor: string;
  nest_ratio: string;
  units_per_layer: string;
  layers_per_unit: string;
  hazmat_class: string;
  un_rating: string;
  temp_min_c: string;
  temp_max_c: string;
  cost: string;
  notes: string;
  is_returnable: boolean;
  is_stackable: boolean;
};

const BLANK: FormState = {
  code: "", name: "", packaging_class: "carton", material: "",
  inner_length_cm: "30", inner_width_cm: "20", inner_height_cm: "15",
  outer_length_cm: "", outer_width_cm: "", outer_height_cm: "",
  max_weight_kg: "20", tare_weight_kg: "0.2", max_volume_fill_pct: "85",
  dim_weight_divisor: "", nest_ratio: "", units_per_layer: "", layers_per_unit: "",
  hazmat_class: "", un_rating: "", temp_min_c: "", temp_max_c: "",
  cost: "0", notes: "", is_returnable: false, is_stackable: true,
};

const s = (v: number | null | undefined) => (v == null ? "" : String(v));

function fromRecord(r: PackagingType): FormState {
  return {
    code: r.code, name: r.name, packaging_class: r.packaging_class,
    material: r.material ?? "",
    inner_length_cm: s(r.inner_length_cm), inner_width_cm: s(r.inner_width_cm), inner_height_cm: s(r.inner_height_cm),
    outer_length_cm: s(r.outer_length_cm), outer_width_cm: s(r.outer_width_cm), outer_height_cm: s(r.outer_height_cm),
    max_weight_kg: s(r.max_weight_kg), tare_weight_kg: s(r.tare_weight_kg),
    max_volume_fill_pct: s(r.max_volume_fill_pct), dim_weight_divisor: s(r.dim_weight_divisor),
    nest_ratio: s(r.nest_ratio), units_per_layer: s(r.units_per_layer), layers_per_unit: s(r.layers_per_unit),
    hazmat_class: r.hazmat_class ?? "", un_rating: r.un_rating ?? "",
    temp_min_c: s(r.temp_min_c), temp_max_c: s(r.temp_max_c),
    cost: s(r.cost), notes: r.notes ?? "",
    is_returnable: r.is_returnable, is_stackable: r.is_stackable,
  };
}

function toPayload(f: FormState): PackagingUpsertPayload {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const int = (v: string) => (v.trim() === "" ? null : Math.trunc(Number(v)));
  return {
    code: f.code.trim(),
    name: f.name.trim(),
    packaging_class: f.packaging_class,
    material: f.material.trim() || null,
    inner_length_cm: Number(f.inner_length_cm),
    inner_width_cm: Number(f.inner_width_cm),
    inner_height_cm: Number(f.inner_height_cm),
    outer_length_cm: num(f.outer_length_cm),
    outer_width_cm: num(f.outer_width_cm),
    outer_height_cm: num(f.outer_height_cm),
    max_weight_kg: Number(f.max_weight_kg),
    tare_weight_kg: Number(f.tare_weight_kg),
    max_volume_fill_pct: Number(f.max_volume_fill_pct),
    dim_weight_divisor: num(f.dim_weight_divisor),
    nest_ratio: num(f.nest_ratio),
    units_per_layer: int(f.units_per_layer),
    layers_per_unit: int(f.layers_per_unit),
    hazmat_class: f.hazmat_class.trim() || null,
    un_rating: f.un_rating.trim() || null,
    temp_min_c: num(f.temp_min_c),
    temp_max_c: num(f.temp_max_c),
    cost: Number(f.cost),
    notes: f.notes.trim() || null,
    is_returnable: f.is_returnable,
    is_stackable: f.is_stackable,
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PackagingSpecForm({ businessId, record, readOnly, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(record ? fromRecord(record) : BLANK);
  const upsert = useUpsertPackaging(businessId);

  useEffect(() => {
    setForm(record ? fromRecord(record) : BLANK);
  }, [record?.id, record?.row_version]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const derived = useMemo(() => {
    const probe = {
      inner_length_cm: Number(form.inner_length_cm) || 0,
      inner_width_cm: Number(form.inner_width_cm) || 0,
      inner_height_cm: Number(form.inner_height_cm) || 0,
      max_volume_fill_pct: Number(form.max_volume_fill_pct) || 100,
      outer_length_cm: form.outer_length_cm === "" ? null : Number(form.outer_length_cm),
      outer_width_cm: form.outer_width_cm === "" ? null : Number(form.outer_width_cm),
      outer_height_cm: form.outer_height_cm === "" ? null : Number(form.outer_height_cm),
      dim_weight_divisor: form.dim_weight_divisor === "" ? null : Number(form.dim_weight_divisor),
    } as PackagingType;
    return { usable: usableVolumeCm3(probe), dim: dimWeightKg(probe) };
  }, [form]);

  const invalid =
    !form.code.trim() ||
    !form.name.trim() ||
    !(Number(form.inner_length_cm) > 0) ||
    !(Number(form.inner_width_cm) > 0) ||
    !(Number(form.inner_height_cm) > 0);

  const save = () => {
    upsert.mutate(
      { id: record?.id ?? null, rowVersion: record?.row_version ?? null, payload: toPayload(form) },
      {
        onSuccess: (row) => {
          toast.success(record ? "Packaging updated" : "Packaging created");
          onSaved(row);
        },
        onError: (e) => toast.error(packagingErrorMessage(e)),
      },
    );
  };

  return (
    <div className="space-y-6">
      <Section title="Identity">
        <div className="min-w-0 grid gap-4 @xl/page:grid-cols-2">
          <Field label="Code">
            <Input value={form.code} disabled={readOnly} onChange={(e) => set("code", e.target.value)} placeholder="CTN-M" />
          </Field>
          <Field label="Name">
            <Input value={form.name} disabled={readOnly} onChange={(e) => set("name", e.target.value)} placeholder="Medium carton" />
          </Field>
          <Field label="Class">
            <Select value={form.packaging_class} disabled={readOnly}
              onValueChange={(v) => set("packaging_class", v as PackagingClass)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PACKAGING_CLASSES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Material">
            <Input value={form.material} disabled={readOnly} onChange={(e) => set("material", e.target.value)} placeholder="Double-wall board" />
          </Field>
        </div>
      </Section>

      <Section title="Geometry" description="Inner dimensions drive the fit test; outer dimensions drive dimensional weight.">
        <div className="min-w-0 grid gap-4 @xl/page:grid-cols-3">
          {(["inner_length_cm", "inner_width_cm", "inner_height_cm"] as const).map((k) => (
            <Field key={k} label={`Inner ${k.split("_")[1]} (cm)`}>
              <Input type="number" step="0.1" disabled={readOnly} value={form[k]} onChange={(e) => set(k, e.target.value)} />
            </Field>
          ))}
          {(["outer_length_cm", "outer_width_cm", "outer_height_cm"] as const).map((k) => (
            <Field key={k} label={`Outer ${k.split("_")[1]} (cm)`}>
              <Input type="number" step="0.1" disabled={readOnly} value={form[k]} placeholder="Same as inner"
                onChange={(e) => set(k, e.target.value)} />
            </Field>
          ))}
          <Field label="Max fill %" hint="Cartonization never fills beyond this.">
            <Input type="number" step="1" disabled={readOnly} value={form.max_volume_fill_pct}
              onChange={(e) => set("max_volume_fill_pct", e.target.value)} />
          </Field>
          <Field label="Dim weight divisor" hint="Blank = carrier default.">
            <Input type="number" step="1" disabled={readOnly} value={form.dim_weight_divisor}
              onChange={(e) => set("dim_weight_divisor", e.target.value)} />
          </Field>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="text-xs text-muted-foreground">Usable volume</p>
            <p className="font-semibold tabular-nums">{Math.round(derived.usable).toLocaleString()} cm³</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Dim weight {derived.dim == null ? "—" : `${derived.dim.toFixed(2)} kg`}
            </p>
          </div>
        </div>
      </Section>

      <Section title="Weight & handling">
        <div className="min-w-0 grid gap-4 @xl/page:grid-cols-3">
          <Field label="Max weight (kg)">
            <Input type="number" step="0.01" disabled={readOnly} value={form.max_weight_kg} onChange={(e) => set("max_weight_kg", e.target.value)} />
          </Field>
          <Field label="Tare weight (kg)">
            <Input type="number" step="0.01" disabled={readOnly} value={form.tare_weight_kg} onChange={(e) => set("tare_weight_kg", e.target.value)} />
          </Field>
          <Field label="Unit cost">
            <Input type="number" step="0.01" disabled={readOnly} value={form.cost} onChange={(e) => set("cost", e.target.value)} />
          </Field>
          <Field label="Nest ratio" hint="Storage footprint when nested.">
            <Input type="number" step="0.01" disabled={readOnly} value={form.nest_ratio} onChange={(e) => set("nest_ratio", e.target.value)} />
          </Field>
          <Field label="Units per layer">
            <Input type="number" disabled={readOnly} value={form.units_per_layer} onChange={(e) => set("units_per_layer", e.target.value)} />
          </Field>
          <Field label="Layers per unit">
            <Input type="number" disabled={readOnly} value={form.layers_per_unit} onChange={(e) => set("layers_per_unit", e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Switch id="spec-returnable" disabled={readOnly} checked={form.is_returnable} onCheckedChange={(v) => set("is_returnable", v)} />
            <Label htmlFor="spec-returnable">Returnable</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="spec-stackable" disabled={readOnly} checked={form.is_stackable} onCheckedChange={(v) => set("is_stackable", v)} />
            <Label htmlFor="spec-stackable">Stackable</Label>
          </div>
        </div>
      </Section>

      <Section title="Compliance" description="Hazmat and cold-chain constraints filter the cartonization candidates.">
        <div className="min-w-0 grid gap-4 @xl/page:grid-cols-4">
          <Field label="Hazmat class">
            <Input disabled={readOnly} value={form.hazmat_class} onChange={(e) => set("hazmat_class", e.target.value)} placeholder="e.g. 3" />
          </Field>
          <Field label="UN rating">
            <Input disabled={readOnly} value={form.un_rating} onChange={(e) => set("un_rating", e.target.value)} placeholder="4G/X10/S" />
          </Field>
          <Field label="Temp min (°C)">
            <Input type="number" step="0.1" disabled={readOnly} value={form.temp_min_c} onChange={(e) => set("temp_min_c", e.target.value)} />
          </Field>
          <Field label="Temp max (°C)">
            <Input type="number" step="0.1" disabled={readOnly} value={form.temp_max_c} onChange={(e) => set("temp_max_c", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="Notes">
        <Textarea rows={3} disabled={readOnly} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Section>

      {!readOnly && (
        <div className="flex items-center gap-2 border-t pt-4">
          <Button onClick={save} disabled={invalid || upsert.isPending}>
            {record ? "Save changes" : "Create packaging"}
          </Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          ) : null}
          {record ? (
            <span className="ml-auto text-xs text-muted-foreground">Version {record.row_version}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
