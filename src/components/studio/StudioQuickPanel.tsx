import { normalizeError } from "@/services/resilience";
/**
 * Studio Quick Panel
 * 
 * A slide-over drawer that lets admins manage custom fields
 * for the current entity type without leaving the page.
 */
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus,
  ExternalLink,
  GripVertical,
  Trash2,
  Loader2,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

interface CustomField {
  id: string;
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean | null;
  is_visible: boolean | null;
  display_order: number | null;
}

interface StudioQuickPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: string;
}

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Yes/No" },
  { value: "select", label: "Dropdown" },
  { value: "textarea", label: "Long Text" },
  { value: "email", label: "Email" },
  { value: "url", label: "URL" },
  { value: "phone", label: "Phone" },
];

const ENTITY_LABELS: Record<string, string> = {
  contact: "Contacts",
  invoice: "Invoices",
  bill: "Bills",
  product: "Products",
  estimate: "Estimates",
  expense: "Expenses",
  sales_order: "Sales Orders",
  purchase_order: "Purchase Orders",
  employee: "Employees",
};

export function StudioQuickPanel({
  open,
  onOpenChange,
  entityType,
}: StudioQuickPanelProps) {
  const { currentOrg } = useOrganization();
  const navigate = useNavigate();
  const [fields, setFields] = useState<CustomField[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");
  const [isSaving, setIsSaving] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !currentOrg) return;
    fetchFields();
  }, [open, currentOrg?.id, entityType]);

  const fetchFields = async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: entity_field_configs is workspace-wide custom field schema
        .from("entity_field_configs")
        .select("id, field_key, field_label, field_type, is_required, is_visible, display_order")
        .eq("organization_id", currentOrg.id)
        .eq("entity_type", entityType)
        .order("display_order", { ascending: true });

      if (error) throw error;
      setFields((data || []) as unknown as CustomField[]);
    } catch (err) {
      console.error("Error fetching fields:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddField = async () => {
    if (!currentOrg || !newFieldLabel.trim()) return;
    setIsSaving(true);
    try {
      const fieldKey = `custom_${newFieldLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      const maxOrder = fields.reduce((max, f) => Math.max(max, f.display_order || 0), 0);

      const { error } = await supabase.from("entity_field_configs").insert({
        organization_id: currentOrg.id,
        entity_type: entityType,
        field_key: fieldKey,
        field_label: newFieldLabel.trim(),
        field_type: newFieldType,
        is_required: false,
        is_visible: true,
        display_order: maxOrder + 1,
      } as any);

      if (error) throw error;
      toast.success("Field added");
      setNewFieldLabel("");
      setNewFieldType("text");
      setShowAddForm(false);
      await fetchFields();
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to add field");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleField = async (field: CustomField) => {
    const { error } = await supabase
      .from("entity_field_configs")
      .update({ is_visible: !field.is_visible } as any)
      .eq("id", field.id);

    if (!error) {
      setFields((prev) =>
        prev.map((f) =>
          f.id === field.id ? { ...f, is_visible: !f.is_visible } : f
        )
      );
    }
  };

  const handleDeleteField = async (fieldId: string) => {
    const { error } = await supabase
      .from("entity_field_configs")
      .delete()
      .eq("id", fieldId);

    if (!error) {
      setFields((prev) => prev.filter((f) => f.id !== fieldId));
      toast.success("Field removed");
    }
  };

  const entityLabel = ENTITY_LABELS[entityType] || entityType;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[380px] sm:w-[420px] p-0 flex flex-col">
        <SheetHeader className="p-6 pb-4">
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-primary" />
            <SheetTitle>Customize {entityLabel}</SheetTitle>
          </div>
          <SheetDescription>
            Add or manage custom fields for {entityLabel.toLowerCase()}.
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <ScrollArea className="flex-1 p-6">
          <div className="space-y-4">
            {/* Custom Fields List */}
            <div className="space-y-1">
              <Label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
                Custom Fields ({fields.length})
              </Label>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : fields.length === 0 && !showAddForm ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <p>No custom fields yet.</p>
                <p className="text-xs mt-1">Add fields to extend {entityLabel.toLowerCase()}.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {fields.map((field) => (
                  <div
                    key={field.id}
                    className="flex items-center gap-2 rounded-lg border p-3 bg-card"
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground/50 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {field.field_label}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge variant="secondary" className="text-[10px] h-4 px-1">
                          {field.field_type}
                        </Badge>
                        {field.is_required && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 text-destructive border-destructive/30">
                            required
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Switch
                      checked={!!field.is_visible}
                      onCheckedChange={() => handleToggleField(field)}
                      className="flex-shrink-0"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteField(field.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Field Form */}
            {showAddForm ? (
              <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                <Label htmlFor="new-field-label" className="text-sm">
                  Field Label
                </Label>
                <Input
                  id="new-field-label"
                  placeholder="e.g. Project Code"
                  value={newFieldLabel}
                  onChange={(e) => setNewFieldLabel(e.target.value)}
                />
                <Label className="text-sm">Field Type</Label>
                <Select value={newFieldType} onValueChange={setNewFieldType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={handleAddField}
                    disabled={!newFieldLabel.trim() || isSaving}
                  >
                    {isSaving ? "Adding..." : "Add Field"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowAddForm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={() => setShowAddForm(true)}
              >
                <Plus className="h-4 w-4" />
                Add Custom Field
              </Button>
            )}
          </div>
        </ScrollArea>

        <Separator />

        <div className="p-4">
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() => {
              onOpenChange(false);
              navigate("/studio");
            }}
          >
            <ExternalLink className="h-4 w-4" />
            Open Full Studio
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
