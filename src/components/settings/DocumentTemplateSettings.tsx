import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle 
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { 
  Plus, 
  FileText, 
  Receipt, 
  FileCheck, 
  CreditCard, 
  Loader2,
  MoreVertical,
  Pencil,
  Copy,
  Trash2,
  Star,
  ShoppingCart,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDocumentTemplates } from "@/hooks/useDocumentTemplates";
import { useOrganization } from "@/hooks/useOrganization";
import { DocumentTemplateBuilder } from "@/components/templates/DocumentTemplateBuilder";
import type { 
  DocumentTemplateType, 
  DocumentTemplateInput, 
  DocumentTemplate 
} from "@/types/documentTemplate";
import { DOCUMENT_TYPE_LABELS } from "@/types/documentTemplate";

const TEMPLATE_TYPE_ICONS: Record<DocumentTemplateType, React.ReactNode> = {
  loan_agreement: <FileText className="h-5 w-5" />,
  repayment_schedule: <FileCheck className="h-5 w-5" />,
  loan_statement: <CreditCard className="h-5 w-5" />,
  client_statement: <CreditCard className="h-5 w-5" />,
  loan_payment_receipt: <Receipt className="h-5 w-5" />,
};

export function DocumentTemplateSettings() {
  const { currentOrg } = useOrganization();
  const { 
    templates, 
    isLoading, 
    isSaving, 
    createTemplate, 
    updateTemplate, 
    deleteTemplate,
    duplicateTemplate,
    setAsDefault 
  } = useDocumentTemplates();

  const [activeType, setActiveType] = useState<DocumentTemplateType>("invoice");
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<DocumentTemplate | null>(null);
  const [deleteConfirmTemplate, setDeleteConfirmTemplate] = useState<DocumentTemplate | null>(null);

  const filteredTemplates = templates.filter(t => t.template_type === activeType);

  const handleCreateTemplate = () => {
    setEditingTemplate(null);
    setIsBuilderOpen(true);
  };

  const handleEditTemplate = (template: DocumentTemplate) => {
    setEditingTemplate(template);
    setIsBuilderOpen(true);
  };

  const handleSaveTemplate = async (input: DocumentTemplateInput) => {
    if (editingTemplate) {
      await updateTemplate(editingTemplate.id, input);
    } else {
      await createTemplate(input);
    }
    setIsBuilderOpen(false);
    setEditingTemplate(null);
  };

  const handleDuplicate = async (template: DocumentTemplate) => {
    await duplicateTemplate(template.id, `${template.template_name} (Copy)`);
  };

  const handleSetDefault = async (template: DocumentTemplate) => {
    await setAsDefault(template.id);
  };

  const handleDelete = async () => {
    if (deleteConfirmTemplate) {
      await deleteTemplate(deleteConfirmTemplate.id);
      setDeleteConfirmTemplate(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Document Templates
              </CardTitle>
              <CardDescription>
                Control which business information appears on your invoices, estimates, and other documents.
              </CardDescription>
            </div>
            <Button onClick={handleCreateTemplate}>
              <Plus className="h-4 w-4 mr-2" />
              New Template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={activeType} onValueChange={(v) => setActiveType(v as DocumentTemplateType)}>
            <TabsList className="mb-4">
              <TabsTrigger value="invoice" className="gap-2">
                <FileText className="h-4 w-4" />
                Invoices
              </TabsTrigger>
              <TabsTrigger value="estimate" className="gap-2">
                <FileCheck className="h-4 w-4" />
                Estimates
              </TabsTrigger>
              <TabsTrigger value="proforma" className="gap-2">
                <Receipt className="h-4 w-4" />
                Proforma
              </TabsTrigger>
              <TabsTrigger value="credit_note" className="gap-2">
                <CreditCard className="h-4 w-4" />
                Credit Notes
              </TabsTrigger>
            </TabsList>

            {(["invoice", "estimate", "proforma", "credit_note"] as DocumentTemplateType[]).map((type) => (
              <TabsContent key={type} value={type}>
                {filteredTemplates.length === 0 ? (
                  <div className="text-center py-12 border rounded-lg border-dashed">
                    <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                      {TEMPLATE_TYPE_ICONS[type]}
                    </div>
                    <h3 className="text-lg font-medium mb-2">No {DOCUMENT_TYPE_LABELS[type]} Templates</h3>
                    <p className="text-muted-foreground mb-4">
                      Create your first template to control which fields appear on your {DOCUMENT_TYPE_LABELS[type].toLowerCase()}s.
                    </p>
                    <Button onClick={handleCreateTemplate}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create Template
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredTemplates.map((template) => (
                      <Card key={template.id} className="relative group cursor-pointer hover:border-primary transition-colors" onClick={() => handleEditTemplate(template)}>
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between">
                            <div className="space-y-1">
                              <CardTitle className="text-base flex items-center gap-2">
                                {template.template_name}
                                {template.is_default && (
                                  <Badge variant="secondary" className="text-xs">
                                    <Star className="h-3 w-3 mr-1 fill-current" />
                                    Default
                                  </Badge>
                                )}
                              </CardTitle>
                              <CardDescription className="text-xs">
                                {template.branch_id ? "Branch override" : "Company default"}
                              </CardDescription>
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditTemplate(template); }}>
                                  <Pencil className="h-4 w-4 mr-2" />
                                  Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDuplicate(template); }}>
                                  <Copy className="h-4 w-4 mr-2" />
                                  Duplicate
                                </DropdownMenuItem>
                                {!template.is_default && (
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSetDefault(template); }}>
                                    <Star className="h-4 w-4 mr-2" />
                                    Set as Default
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem 
                                  onClick={(e) => { e.stopPropagation(); setDeleteConfirmTemplate(template); }}
                                  className="text-destructive"
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="text-sm font-semibold text-muted-foreground">
                            {template.document_title_format || DOCUMENT_TYPE_LABELS[type].toUpperCase()}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {template.show_tax_column && <Badge variant="outline" className="text-xs">Tax</Badge>}
                            {template.show_discount_column && <Badge variant="outline" className="text-xs">Discount</Badge>}
                            {template.show_signature_line && <Badge variant="outline" className="text-xs">Signature</Badge>}
                            {template.show_total_in_words && <Badge variant="outline" className="text-xs">Words</Badge>}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* Template Builder Dialog */}
      <Dialog open={isBuilderOpen} onOpenChange={setIsBuilderOpen}>
        <DialogContent className="max-w-2xl h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? "Edit Template" : `Create ${DOCUMENT_TYPE_LABELS[activeType]} Template`}
            </DialogTitle>
            <DialogDescription>
              Control which fields and sections appear on your documents.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            <DocumentTemplateBuilder
              templateType={activeType}
              initialTemplate={editingTemplate || undefined}
              onSave={handleSaveTemplate}
              onCancel={() => setIsBuilderOpen(false)}
              isSaving={isSaving}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog 
        open={!!deleteConfirmTemplate} 
        onOpenChange={(open) => !open && setDeleteConfirmTemplate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteConfirmTemplate?.template_name}"? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
