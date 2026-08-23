/**
 * AnalyticAccountSheet — create/edit surface for a single Analytic
 * Account, mounted on the Enterprise UX `DetailSheet` primitive.
 *
 * ≤6 fields (code, type, name, group, description) → sheet is the right
 * scaffold per docs/design-system/audit rules; a full record page would
 * over-serve this configuration record.
 *
 * URL-driven: opens when `?sheet=account` is present. `id=<uuid>` puts
 * the sheet in edit mode; otherwise it's a create. Closing removes both
 * params so refresh + browser back behave as users expect.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  DetailSheet,
  FieldGrid,
  FieldCell,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  useAnalyticAccounts,
  type AnalyticAccount,
  type AnalyticStatus,
  type AnalyticGroup,
} from "@/hooks/useAnalyticAccounts";

/**
 * Lifecycle, not a boolean: `restricted` keeps history readable while
 * blocking new attribution, which is what "stop using this cost center
 * from Q3" actually means.
 */
const ANALYTIC_STATUSES: { value: AnalyticStatus; label: string }[] = [
  { value: "draft", label: "Draft — not yet usable" },
  { value: "active", label: "Active — accepts new postings" },
  { value: "restricted", label: "Restricted — no new postings" },
  { value: "archived", label: "Archived" },
];


interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Editing an existing account; omit for create. */
  account?: AnalyticAccount | null;
  groups: AnalyticGroup[];
}

export function AnalyticAccountSheet({
  open,
  onOpenChange,
  account,
  groups,
}: Props) {
  const { createAccount, updateAccount } = useAnalyticAccounts();
  const { toast } = useToast();
  const mode: "create" | "edit" = account ? "edit" : "create";

  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    analytic_type: "cost_center" as AnalyticType,
    group_id: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset form whenever the sheet opens or the record changes.
  useEffect(() => {
    if (!open) return;
    setForm({
      code: account?.code ?? "",
      name: account?.name ?? "",
      description: account?.description ?? "",
      analytic_type: account?.analytic_type ?? "cost_center",
      group_id: account?.group_id ?? "",
    });
  }, [open, account]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === "edit" && account) {
        await updateAccount.mutateAsync({
          id: account.id,
          code: form.code || null,
          name: form.name,
          description: form.description || null,
          analytic_type: form.analytic_type,
          group_id: form.group_id || null,
        });
        toast({ title: "Analytic account updated" });
      } else {
        await createAccount.mutateAsync({
          code: form.code || undefined,
          name: form.name,
          description: form.description || undefined,
          analytic_type: form.analytic_type,
          group_id: form.group_id || undefined,
        });
        toast({ title: "Analytic account created" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={mode === "edit" ? "Edit analytic account" : "New analytic account"}
      description="Track costs and revenues by cost center, project, or department."
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="analytic-account-form"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "edit" ? "Save changes" : "Create account"}
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form
        id="analytic-account-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="aa-code">Code</Label>
            <Input
              id="aa-code"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="e.g., CC-001"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aa-type">Type *</Label>
            <Select
              value={form.analytic_type}
              onValueChange={(v) =>
                setForm({ ...form, analytic_type: v as AnalyticType })
              }
            >
              <SelectTrigger id="aa-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANALYTIC_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="aa-name">Name *</Label>
              <Input
                id="aa-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Marketing Department"
                required
              />
            </div>
          </FieldCell>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="aa-group">Group</Label>
              <Select
                value={form.group_id || "none"}
                onValueChange={(v) =>
                  setForm({ ...form, group_id: v === "none" ? "" : v })
                }
              >
                <SelectTrigger id="aa-group">
                  <SelectValue placeholder="Select group (optional)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No group</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="aa-desc">Description</Label>
              <Textarea
                id="aa-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                rows={3}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </form>
    </DetailSheet>
  );
}

export default AnalyticAccountSheet;
