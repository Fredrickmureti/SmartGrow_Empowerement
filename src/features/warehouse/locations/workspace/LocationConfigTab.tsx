/**
 * LocationConfigTab — the authoring surface for one position.
 *
 * This is deliberately a *workspace* tab and not a side pane: naming,
 * label code, walk order, capacity and put-away behaviour are deliberate
 * configuration acts with real operational consequence (pick paths,
 * put-away suggestion, capacity checks). They get full width, room for
 * guidance, and an explicit save.
 */
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Section, FieldGrid, FieldCell } from "@/design-system";
import type { LocationNode } from "../types";
import { useLocationMutations } from "../useLocationMutations";

interface Draft {
  name: string;
  barcode: string;
  pick_sequence: string;
  putaway_priority: string;
  capacity_max_units: string;
  is_putaway_target: boolean;
  is_receiving_staging: boolean;
}

function toDraft(n: LocationNode): Draft {
  return {
    name: n.name ?? "",
    barcode: n.barcode ?? "",
    pick_sequence: n.pick_sequence?.toString() ?? "",
    putaway_priority: n.putaway_priority?.toString() ?? "",
    capacity_max_units: n.capacity_max_units?.toString() ?? "",
    is_putaway_target: !!n.is_putaway_target,
    is_receiving_staging: !!n.is_receiving_staging,
  };
}

export default function LocationConfigTab({
  node,
  warehouseId,
}: {
  node: LocationNode;
  warehouseId: string | null;
}) {
  const { update } = useLocationMutations(warehouseId);
  const [draft, setDraft] = useState<Draft>(() => toDraft(node));

  useEffect(() => setDraft(toDraft(node)), [node]);

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <>
      <Section
        title="How operators find it"
        description="The words and codes a picker sees on the floor and on the handheld."
      >
        <FieldGrid columns={2}>
          <FieldCell>
            <Field id="loc-name" label="Description">
              <Input
                id="loc-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
          </FieldCell>
          <FieldCell>
            <Field
              id="loc-barcode"
              label="Label code"
              hint="What the scanner reads. Defaults to the location code."
            >
              <Input
                id="loc-barcode"
                value={draft.barcode}
                placeholder={node.code}
                onChange={(e) => setDraft({ ...draft, barcode: e.target.value })}
              />
            </Field>
          </FieldCell>
          <FieldCell>
            <Field
              id="loc-seq"
              label="Walk order"
              hint="Lower numbers are visited first on a pick round."
            >
              <Input
                id="loc-seq"
                type="number"
                value={draft.pick_sequence}
                onChange={(e) => setDraft({ ...draft, pick_sequence: e.target.value })}
              />
            </Field>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section
        title="How stock behaves here"
        description="Drives put-away suggestion and capacity checks."
      >
        <FieldGrid columns={2}>
          <FieldCell>
            <Field id="loc-cap" label="Holds up to (units)">
              <Input
                id="loc-cap"
                type="number"
                value={draft.capacity_max_units}
                onChange={(e) => setDraft({ ...draft, capacity_max_units: e.target.value })}
              />
            </Field>
          </FieldCell>
          <FieldCell>
            <Field
              id="loc-prio"
              label="Put-away preference"
              hint="Higher wins when the system suggests where to put stock."
            >
              <Input
                id="loc-prio"
                type="number"
                value={draft.putaway_priority}
                onChange={(e) => setDraft({ ...draft, putaway_priority: e.target.value })}
              />
            </Field>
          </FieldCell>
          <FieldCell span={2}>
            <Toggle
              id="loc-putaway"
              label="Suggest this location for put-away"
              checked={draft.is_putaway_target}
              onChange={(v) => setDraft({ ...draft, is_putaway_target: v })}
            />
          </FieldCell>
          <FieldCell span={2}>
            <Toggle
              id="loc-staging"
              label="Goods land here when received"
              checked={draft.is_receiving_staging}
              onChange={(v) => setDraft({ ...draft, is_receiving_staging: v })}
            />
          </FieldCell>
        </FieldGrid>

        <div className="pt-4">
          <Button
            disabled={update.isPending}
            onClick={() =>
              update.mutate({
                id: node.id,
                patch: {
                  name: draft.name,
                  barcode: draft.barcode.trim() || null,
                  pick_sequence: num(draft.pick_sequence),
                  putaway_priority: num(draft.putaway_priority),
                  capacity_max_units: num(draft.capacity_max_units),
                  is_putaway_target: draft.is_putaway_target,
                  is_receiving_staging: draft.is_receiving_staging,
                },
              })
            }
          >
            <Save className="mr-2 h-4 w-4" /> Save location
          </Button>
        </div>
      </Section>
    </>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
