import { useState, useCallback } from "react";
import { useEntityFields, EntityFieldConfig, EntityType } from "@/hooks/useEntityFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  GripVertical,
  FileText,
  User,
  Table2,
  StickyNote,
  LayoutTemplate,
  Info,
  Loader2,
  X,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface DocumentFieldPlacerProps {
  entityType: EntityType;
}

const DOCUMENT_SECTIONS = [
  { key: "header", label: "Header", description: "Near document number & date", icon: LayoutTemplate },
  { key: "details", label: "Customer Details", description: "Beside Bill To / Ship To", icon: User },
  { key: "after_items", label: "After Items", description: "Below the line items table", icon: Table2 },
  { key: "notes", label: "Notes Section", description: "With notes & payment info", icon: StickyNote },
  { key: "footer", label: "Footer", description: "At the bottom of the document", icon: FileText },
  { key: "additional", label: "Additional Info", description: "Separate info block (default)", icon: Info },
] as const;

type SectionKey = typeof DOCUMENT_SECTIONS[number]["key"];

export function DocumentFieldPlacer({ entityType }: DocumentFieldPlacerProps) {
  const { fieldConfigs, isLoading, updateField } = useEntityFields(entityType);
  const [draggedField, setDraggedField] = useState<EntityFieldConfig | null>(null);
  const [dragOverSection, setDragOverSection] = useState<string | null>(null);

  // Group fields by their current document_section
  const fieldsBySection = DOCUMENT_SECTIONS.reduce((acc, section) => {
    acc[section.key] = fieldConfigs.filter(
      (f) => (f.document_section || "additional") === section.key
    );
    return acc;
  }, {} as Record<SectionKey, EntityFieldConfig[]>);

  // Unplaced fields (no section assigned, treated as "additional")
  const unplacedFields = fieldConfigs.filter(
    (f) => !f.document_section || f.document_section === "additional"
  );

  const handleDragStart = useCallback((e: React.DragEvent, field: EntityFieldConfig) => {
    setDraggedField(field);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", field.id);
    // Add a drag image style
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    setDraggedField(null);
    setDragOverSection(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, sectionKey: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverSection(sectionKey);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverSection(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, sectionKey: string) => {
    e.preventDefault();
    setDragOverSection(null);

    if (!draggedField) return;

    // Don't update if dropped in the same section
    const currentSection = draggedField.document_section || "additional";
    if (currentSection === sectionKey) {
      setDraggedField(null);
      return;
    }

    try {
      await updateField(draggedField.id, { document_section: sectionKey });
      toast.success(`"${draggedField.field_label}" moved to ${DOCUMENT_SECTIONS.find(s => s.key === sectionKey)?.label}`);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field placement");
    }

    setDraggedField(null);
  }, [draggedField, updateField]);

  const handleRemoveFromSection = useCallback(async (field: EntityFieldConfig) => {
    try {
      await updateField(field.id, { document_section: "additional" });
      toast.success(`"${field.field_label}" moved back to Additional Info`);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field placement");
    }
  }, [updateField]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (fieldConfigs.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <LayoutTemplate className="h-4 w-4" />
          Document Field Placement
        </CardTitle>
        <CardDescription className="text-xs">
          Drag custom fields into document sections to control where they appear on printed documents
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Document Layout Preview */}
        <div className="border rounded-lg bg-background overflow-hidden">
          {/* Visual document representation */}
          <div className="p-3 border-b bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Document Layout</p>
          </div>

          <div className="divide-y">
            {DOCUMENT_SECTIONS.map((section) => {
              const Icon = section.icon;
              const sectionFields = fieldsBySection[section.key];
              const isOver = dragOverSection === section.key;
              const isAdditional = section.key === "additional";

              return (
                <div
                  key={section.key}
                  onDragOver={(e) => handleDragOver(e, section.key)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, section.key)}
                  className={`p-3 transition-colors ${
                    isOver
                      ? "bg-primary/10 ring-2 ring-inset ring-primary/40"
                      : "hover:bg-muted/20"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-xs font-medium">{section.label}</span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">— {section.description}</span>
                    {sectionFields.length > 0 && (
                      <Badge variant="secondary" className="text-xs ml-auto">
                        {sectionFields.length}
                      </Badge>
                    )}
                  </div>

                  {/* Placed fields */}
                  <div className="flex flex-wrap gap-1.5 min-h-[32px]">
                    {sectionFields.length === 0 && !isOver ? (
                      <div className="w-full rounded border border-dashed border-muted-foreground/25 py-2 px-3 text-xs text-muted-foreground/50 text-center">
                        {isAdditional ? "Default drop zone" : "Drop fields here"}
                      </div>
                    ) : (
                      sectionFields.map((field) => (
                        <div
                          key={field.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, field)}
                          onDragEnd={handleDragEnd}
                          className="group flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-xs cursor-grab active:cursor-grabbing shadow-sm hover:shadow transition-shadow"
                        >
                          <GripVertical className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                          <span className="font-medium">{field.field_label}</span>
                          <Badge variant="outline" className="text-[10px] px-1 py-0">
                            {field.field_type}
                          </Badge>
                          {!isAdditional && (
                            <button
                              onClick={() => handleRemoveFromSection(field)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5"
                              title="Remove from section"
                            >
                              <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                            </button>
                          )}
                        </div>
                      ))
                    )}

                    {isOver && (
                      <div className="rounded-md border-2 border-dashed border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-primary font-medium">
                        Drop here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
