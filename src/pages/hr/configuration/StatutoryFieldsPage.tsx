/**
 * Statutory Fields configuration — HR operator UX.
 *
 * What an HR manager can do here:
 *  - See which identifiers the installed payroll pack requires.
 *  - Tweak per-business toggles: Required / Blocks onboarding /
 *    Blocks payroll, plus a custom Label and Help text.
 *  - Reset a row back to the pack default.
 *
 * What they intentionally cannot do here:
 *  - Enter regex patterns, country codes, data types, or token IDs
 *    — those are pack-author concerns and live in the Platform
 *    Admin localization pack editor.
 *  - Pick identifiers from a global hardcoded catalog — if no pack
 *    is installed for this business there are no requirements to
 *    surface, and the page sends them to install one.
 */
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Loader2, Shield, ArrowRight, RotateCcw, Info, Package } from "lucide-react";
import { Link } from "react-router-dom";
import {
  useStatutoryFieldConfig,
  type StatutoryRequirement,
} from "@/hooks/hr/useStatutoryFieldConfig";
import { useBusinessModules } from "@/hooks/hr/useBusinessModules";
import { ConfigPageHeader } from "./_ConfigShell";

export default function StatutoryFieldsPage() {
  const { requirements, isLoading, upsertOverride, resetToPackDefault } =
    useStatutoryFieldConfig();
  const modules = useBusinessModules();
  const [editing, setEditing] = useState<StatutoryRequirement | null>(null);

  if (isLoading) return <Spinner />;

  // Payroll module not installed → identifiers are irrelevant here.
  if (modules.isReady && !modules.payroll) {
    return (
      <div className="space-y-4">
        <ConfigPageHeader
          title="Statutory fields"
          subtitle="Statutory identifiers belong to the Payroll module."
        />
        <EmptyState
          icon={<Package className="h-5 w-5 text-muted-foreground" />}
          title="Payroll is not installed"
          body="Install the Payroll module to collect statutory identifiers (tax, social security, health insurance) for your employees."
          cta={{ to: "/apps", label: "Open App Marketplace" }}
        />
      </div>
    );
  }

  // No pack requirements yet → no localization pack installed.
  if (requirements.length === 0) {
    return (
      <div className="space-y-4">
        <ConfigPageHeader
          title="Statutory fields"
          subtitle="No country localization pack is installed for this business yet."
        />
        <EmptyState
          icon={<Shield className="h-5 w-5 text-muted-foreground" />}
          title="Install a country pack"
          body="Statutory identifiers (tax PIN, social security, health insurance, etc.) come from the country payroll pack you install. Install one to see and customize the fields your jurisdiction requires."
          cta={{ to: "/hr/payroll/localization", label: "Open Payroll → Localization" }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ConfigPageHeader
        title="Statutory identifiers required for payroll"
        subtitle="These come from the installed payroll pack. Per-business toggles are saved as overrides; you can reset any row back to the pack default."
      />

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Pack-required identifiers
            <Badge variant="secondary" className="ml-auto">
              {requirements.length}
            </Badge>
          </div>

          <div className="divide-y">
            {requirements.map((r) => (
              <RequirementRow
                key={`${r.requirement_key}-${r.country_code ?? ""}`}
                r={r}
                onEdit={() => setEditing(r)}
                onReset={() =>
                  resetToPackDefault.mutate({
                    requirement_key: r.requirement_key,
                    country_code: r.country_code,
                  })
                }
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <EditDrawer
        editing={editing}
        onClose={() => setEditing(null)}
        onSave={(payload) => {
          upsertOverride.mutate(payload);
          setEditing(null);
        }}
      />
    </div>
  );
}

function RequirementRow({
  r,
  onEdit,
  onReset,
}: {
  r: StatutoryRequirement;
  onEdit: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {r.label}
          {r.country_code && (
            <Badge variant="outline" className="text-[10px] uppercase">
              {r.country_code}
            </Badge>
          )}
          {r.has_override && (
            <Badge variant="secondary" className="text-[10px]">
              Customized
            </Badge>
          )}
        </div>
        {r.help_text && (
          <div className="text-xs text-muted-foreground mt-0.5">{r.help_text}</div>
        )}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {r.is_required && (
            <Badge variant="outline" className="text-[10px]">Required</Badge>
          )}
          {r.blocks_onboarding && (
            <Badge variant="outline" className="text-[10px]">Blocks onboarding</Badge>
          )}
          {r.blocks_payroll && (
            <Badge variant="outline" className="text-[10px]">Blocks payroll</Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {r.has_override && (
          <Button variant="ghost" size="sm" onClick={onReset} title="Reset to pack default">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
      </div>
    </div>
  );
}

function EditDrawer({
  editing,
  onClose,
  onSave,
}: {
  editing: StatutoryRequirement | null;
  onClose: () => void;
  onSave: (input: {
    requirement_key: string;
    country_code: string | null;
    label: string;
    help_text: string;
    is_required: boolean;
    blocks_onboarding: boolean;
    blocks_payroll: boolean;
  }) => void;
}) {
  const [label, setLabel] = useState("");
  const [help, setHelp] = useState("");
  const [required, setRequired] = useState(true);
  const [blocksOb, setBlocksOb] = useState(false);
  const [blocksPay, setBlocksPay] = useState(true);

  // Seed from the row each time the drawer opens.
  if (editing) {
    if (label === "" && help === "" && required === true && blocksOb === false && blocksPay === true) {
      // first render after open — seed
      setLabel(editing.label);
      setHelp(editing.help_text ?? "");
      setRequired(editing.is_required);
      setBlocksOb(editing.blocks_onboarding);
      setBlocksPay(editing.blocks_payroll);
    }
  }

  return (
    <Sheet
      open={!!editing}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setLabel("");
          setHelp("");
          setRequired(true);
          setBlocksOb(false);
          setBlocksPay(true);
        }
      }}
    >
      <SheetContent className="sm:max-w-md">
        {editing && (
          <>
            <SheetHeader>
              <SheetTitle>Edit {editing.label}</SheetTitle>
              <SheetDescription>
                Customize how this identifier behaves for your business. Regex
                validation and country are managed by the pack.
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 py-4">
              <FieldRow label="Display label">
                <Input value={label} onChange={(e) => setLabel(e.target.value)} />
              </FieldRow>
              <FieldRow label="Help text shown on the employee form">
                <Input
                  value={help}
                  onChange={(e) => setHelp(e.target.value)}
                  placeholder={editing.help_text ?? "Optional"}
                />
              </FieldRow>
              <div className="space-y-2 rounded-md border p-3 bg-muted/30">
                <ToggleRow
                  label="Required"
                  description="Employees must provide a value."
                  checked={required}
                  onChange={setRequired}
                />
                <ToggleRow
                  label="Blocks onboarding"
                  description="New employees cannot be marked onboarded without this."
                  checked={blocksOb}
                  onChange={setBlocksOb}
                />
                <ToggleRow
                  label="Blocks payroll"
                  description="Payroll runs cannot include this employee without this."
                  checked={blocksPay}
                  onChange={setBlocksPay}
                />
              </div>
              {editing.validation_regex && (
                <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs">
                  <Info className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
                  <span className="text-muted-foreground">
                    Pack validation: values must match a defined pattern. The
                    employee form will show the help text above if entry is invalid.
                  </span>
                </div>
              )}
            </div>
            <SheetFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() =>
                  onSave({
                    requirement_key: editing.requirement_key,
                    country_code: editing.country_code,
                    label,
                    help_text: help,
                    is_required: required,
                    blocks_onboarding: blocksOb,
                    blocks_payroll: blocksPay,
                  })
                }
              >
                Save override
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} />
      <div className="space-y-0.5">
        <div className="text-sm font-medium leading-none">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </label>
  );
}

function EmptyState({
  icon,
  title,
  body,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: { to: string; label: string };
}) {
  return (
    <Card>
      <CardContent className="p-8 text-center space-y-3">
        <div className="mx-auto h-10 w-10 rounded-full bg-muted flex items-center justify-center">
          {icon}
        </div>
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">{body}</p>
        </div>
        <Button asChild>
          <Link to={cta.to}>
            {cta.label} <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
