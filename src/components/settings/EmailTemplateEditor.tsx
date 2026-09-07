import { useState } from "react";
import { Mail, Save, RotateCcw, Eye, Code, FileText, Check, X } from "lucide-react";
import { useEmailTemplates, EmailTemplate, TemplateKey } from "@/hooks/useEmailTemplates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";

const TEMPLATE_LABELS: Record<string, { label: string; description: string }> = {
  loan_approved: {
    label: "Loan Approved",
    description: "Email sent to the client when a loan application is approved",
  },
  loan_disbursed: {
    label: "Loan Disbursed",
    description: "Email sent when loan funds are released to the client",
  },
  repayment_receipt: {
    label: "Repayment Receipt",
    description: "Confirmation email when a repayment is received",
  },
  repayment_reminder: {
    label: "Repayment Reminder",
    description: "Reminder email for an instalment falling due",
  },
  repayment_overdue: {
    label: "Repayment Overdue",
    description: "Email for loans in arrears requiring attention",
  },
};

export function EmailTemplateEditor() {
  const { templates, isLoading, updateTemplate, resetToDefault, getTemplateByKey, reseedDefaults } =
    useEmailTemplates();
  const [selectedKey, setSelectedKey] = useState<TemplateKey>("loan_approved");
  const [editMode, setEditMode] = useState(false);
  const [previewMode, setPreviewMode] = useState<"html" | "preview">("preview");
  const [isSeeding, setIsSeeding] = useState(false);

  // Prefer business-specific template when present, fall back to org-level default.
  const selectedTemplate = getTemplateByKey(selectedKey);

  const [editedSubject, setEditedSubject] = useState("");
  const [editedBody, setEditedBody] = useState("");

  const startEditing = () => {
    if (selectedTemplate) {
      setEditedSubject(selectedTemplate.subject);
      setEditedBody(selectedTemplate.html_body);
      setEditMode(true);
    } else {
      toast.error("This template isn't ready yet. Click \"Create defaults\" to seed it.");
    }
  };

  const handleSeedDefaults = async () => {
    try {
      setIsSeeding(true);
      await reseedDefaults();
      toast.success("Default templates created");
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to seed defaults");
    } finally {
      setIsSeeding(false);
    }
  };

  const cancelEditing = () => {
    setEditMode(false);
    setEditedSubject("");
    setEditedBody("");
  };

  const saveChanges = async () => {
    if (!selectedTemplate) return;

    await updateTemplate.mutateAsync({
      id: selectedTemplate.id,
      subject: editedSubject,
      html_body: editedBody,
    });

    setEditMode(false);
  };

  const handleReset = async () => {
    await resetToDefault.mutateAsync(selectedKey);
  };

  // Replace variables with sample data for preview
  const getPreviewHtml = (html: string) => {
    const sampleData: Record<string, string> = {
      "{{loan_number}}": "LN-2024-0001",
      "{{receipt_number}}": "RCP-2024-0001",
      "{{client_name}}": "John Doe",
      "{{customer_name}}": "John Doe",
      "{{principal}}": "50,000.00",
      "{{amount_due}}": "5,250.00",
      "{{outstanding_balance}}": "44,750.00",
      "{{arrears_amount}}": "5,250.00",
      "{{business_name}}": "Your Business",
      "{{total}}": "1,500.00",
      "{{amount}}": "500.00",
      "{{balance_due}}": "1,000.00",
      "{{currency}}": "KES",
      "{{due_date}}": "January 31, 2024",
      "{{valid_until}}": "February 15, 2024",
      "{{payment_date}}": "January 15, 2024",
      "{{payment_method}}": "Bank Transfer",
      "{{days_overdue}}": "7",
      "{{notes}}": "Thank you for your business!",
      "{{view_link}}": "#",
    };

    let preview = html;
    Object.entries(sampleData).forEach(([key, value]) => {
      preview = preview.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), value);
    });
    return sanitizeEmailHtml(preview);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Email Templates</h3>
          <p className="text-sm text-muted-foreground">
            Customize the emails sent to your customers
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Template List */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Templates</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[400px]">
              <div className="space-y-1 p-2">
                {Object.entries(TEMPLATE_LABELS).map(([key, { label, description }]) => {
                  const template = templates.find((t) => t.template_key === key);
                  const isSelected = selectedKey === key;

                  return (
                    <button
                      key={key}
                      onClick={() => {
                        setSelectedKey(key as TemplateKey);
                        setEditMode(false);
                      }}
                      className={`w-full text-left p-3 rounded-lg transition-colors ${
                        isSelected
                          ? "bg-primary/10 border border-primary/20"
                          : "hover:bg-muted"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{label}</span>
                        {template?.is_active && (
                          <Badge variant="secondary" className="text-xs ml-auto">
                            Active
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 pl-6">
                        {description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Editor / Preview */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-medium">
                  {TEMPLATE_LABELS[selectedKey]?.label}
                </CardTitle>
                <CardDescription className="text-xs">
                  {TEMPLATE_LABELS[selectedKey]?.description}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {!editMode ? (
                  <>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          Reset
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Reset Template</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will reset the template to its default content. Any
                            customizations will be lost.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={handleReset}>
                            Reset
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <Button size="sm" onClick={startEditing}>
                      Edit Template
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={cancelEditing}
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={saveChanges}
                      disabled={updateTemplate.isPending}
                    >
                      <Save className="h-3.5 w-3.5 mr-1.5" />
                      Save Changes
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardHeader>

          <Separator />

          <CardContent className="pt-4">
            {selectedTemplate ? (
              <div className="space-y-4">
                {/* Subject */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Subject Line</Label>
                  {editMode ? (
                    <Input
                      value={editedSubject}
                      onChange={(e) => setEditedSubject(e.target.value)}
                      placeholder="Email subject..."
                    />
                  ) : (
                    <div className="p-2 bg-muted rounded text-sm">
                      {selectedTemplate.subject}
                    </div>
                  )}
                </div>

                {/* Body */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Email Body</Label>
                    {!editMode && (
                      <Tabs
                        value={previewMode}
                        onValueChange={(v) => setPreviewMode(v as "html" | "preview")}
                      >
                        <TabsList className="h-7">
                          <TabsTrigger value="preview" className="text-xs h-6 px-2">
                            <Eye className="h-3 w-3 mr-1" />
                            Preview
                          </TabsTrigger>
                          <TabsTrigger value="html" className="text-xs h-6 px-2">
                            <Code className="h-3 w-3 mr-1" />
                            HTML
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    )}
                  </div>

                  {editMode ? (
                    <Textarea
                      value={editedBody}
                      onChange={(e) => setEditedBody(e.target.value)}
                      className="min-h-[300px] font-mono text-xs"
                      placeholder="HTML email body..."
                    />
                  ) : previewMode === "preview" ? (
                    <div
                      className="border rounded-lg p-4 bg-white min-h-[300px] overflow-auto"
                      dangerouslySetInnerHTML={{
                        __html: getPreviewHtml(selectedTemplate.html_body),
                      }}
                    />
                  ) : (
                    <pre className="border rounded-lg p-4 bg-muted text-xs overflow-auto min-h-[300px]">
                      {selectedTemplate.html_body}
                    </pre>
                  )}
                </div>

                {/* Available Variables */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Available Variables</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(selectedTemplate.variables as string[])?.map((variable) => (
                      <Badge
                        key={variable}
                        variant="outline"
                        className="text-xs font-mono cursor-pointer hover:bg-primary/10"
                        onClick={() => {
                          navigator.clipboard.writeText(`{{${variable}}}`);
                          toast.success(`Copied {{${variable}}} to clipboard`);
                        }}
                      >
                        {`{{${variable}}}`}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Click a variable to copy it to clipboard
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <FileText className="h-12 w-12 mb-4 opacity-50" />
                <p>No template found for this key</p>
                <p className="text-sm mb-4">Click the button below to create the default version.</p>
                <Button size="sm" onClick={handleSeedDefaults} disabled={isSeeding}>
                  {isSeeding ? "Creating…" : "Create defaults"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
