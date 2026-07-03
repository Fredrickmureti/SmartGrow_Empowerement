/**
 * AnalyticGroupSheet — create surface for an Analytic Group. ≤3 fields
 * (name, description) so `DetailSheet` is the right scaffold. Opens
 * behind `?sheet=group`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AnalyticGroupSheet({ open, onOpenChange }: Props) {
  const { createGroup } = useAnalyticAccounts();
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", description: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) setForm({ name: "", description: "" });
  }, [open]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createGroup.mutateAsync({
        name: form.name,
        description: form.description || undefined,
      });
      toast({ title: "Group created" });
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
      size="sm"
      title="New analytic group"
      description="Group related analytic accounts together."
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
                form="analytic-group-form"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create group
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form
        id="analytic-group-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="ag-name">Name *</Label>
              <Input
                id="ag-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Regional Cost Centers"
                required
              />
            </div>
          </FieldCell>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="ag-desc">Description</Label>
              <Textarea
                id="ag-desc"
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

export default AnalyticGroupSheet;
