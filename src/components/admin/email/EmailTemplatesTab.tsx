// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, Trash2, Eye, Loader2, FileText, Pencil } from "lucide-react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";
import { DocumentPeekShell } from "@/design-system";

interface EmailTemplate {
  id: string;
  template_key: string;
  name: string;
  description: string | null;
  subject: string;
  html_body: string;
  text_body: string | null;
  variables: string[];
  category: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const categoryLabels: Record<string, string> = {
  welcome: "Welcome",
  reengagement: "Re-engagement",
  announcement: "Announcement",
  system: "System",
  general: "General",
};

export function EmailTemplatesTab() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const previewId = searchParams.get("templatePreview");
  const setPreviewId = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set("templatePreview", id);
          else next.delete("templatePreview");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const { data, error } = await supabase
        .from("platform_email_templates")
        .select("*")
        .order("category", { ascending: true })
        .order("name", { ascending: true });

      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      console.error("Error fetching templates:", error);
      toast({
        title: "Error",
        description: "Failed to load email templates",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = () => {
    navigate("/admin-management/email-center/templates/new");
  };

  const handleEdit = (template: EmailTemplate) => {
    navigate(`/admin-management/email-center/templates/${template.id}/edit`);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this template?")) return;

    try {
      const { error } = await supabase
        .from("platform_email_templates")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast({ title: "Template deleted" });
      fetchTemplates();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to delete template",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const previewTemplate = previewId
    ? templates.find((t) => t.id === previewId) ?? null
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-5 w-5" />
                Email Templates
              </CardTitle>
              <CardDescription>
                Reusable templates for campaigns and automations
              </CardDescription>
            </div>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              New Template
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Variables</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No templates found. Create your first template!
                  </TableCell>
                </TableRow>
              ) : (
                templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{template.name}</p>
                        <p className="text-xs text-muted-foreground">{template.template_key}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {categoryLabels[template.category] || template.category}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{template.subject}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {template.variables.slice(0, 3).map((v) => (
                          <Badge key={v} variant="secondary" className="text-xs">
                            {v}
                          </Badge>
                        ))}
                        {template.variables.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{template.variables.length - 3}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(new Date(template.updated_at), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPreviewId(template.id)}
                          title="Preview"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(template)}
                          title="Edit"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(template.id)}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Preview peek (?templatePreview=<templateId>) — read-mostly per
          docs/design-system/audit/platform-admin.md. */}
      <DocumentPeekShell
        open={!!previewTemplate}
        onOpenChange={(open) => !open && setPreviewId(null)}
        title={
          previewTemplate ? (
            <div className="min-w-0">
              <div className="text-base font-semibold truncate">
                {previewTemplate.name}
              </div>
              {previewTemplate.description && (
                <p className="text-xs text-muted-foreground truncate">
                  {previewTemplate.description}
                </p>
              )}
            </div>
          ) : (
            "Template preview"
          )
        }
        extraHeaderActions={
          previewTemplate && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPreviewId(null);
                handleEdit(previewTemplate);
              }}
            >
              <Pencil className="mr-1.5 h-4 w-4" />
              Edit
            </Button>
          )
        }
      >
        {previewTemplate && (
          <div className="space-y-4 p-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {categoryLabels[previewTemplate.category] || previewTemplate.category}
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {previewTemplate.template_key}
              </Badge>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Subject</Label>
              <p className="font-medium mt-1">{previewTemplate.subject}</p>
            </div>
            {previewTemplate.variables.length > 0 && (
              <div>
                <Label className="text-muted-foreground text-xs">Variables</Label>
                <div className="flex flex-wrap gap-1 mt-1">
                  {previewTemplate.variables.map((v) => (
                    <Badge key={v} variant="secondary">
                      {"{{" + v + "}}"}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <div>
              <Label className="text-muted-foreground text-xs">Preview</Label>
              <div
                className="border rounded-lg p-4 bg-white mt-2 overflow-auto max-h-[60vh]"
                dangerouslySetInnerHTML={{
                  __html: sanitizeEmailHtml(previewTemplate.html_body || ""),
                }}
              />
            </div>
          </div>
        )}
      </DocumentPeekShell>
    </>
  );
}
