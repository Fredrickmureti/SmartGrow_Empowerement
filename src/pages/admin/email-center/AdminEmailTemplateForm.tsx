// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Section } from "@/design-system";
import {
  AdminRecordForm,
  AdminFieldGrid,
  AdminFieldCell,
} from "@/apps/platform-admin";
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

const LIST_PATH = "/admin-management/email-center";

export interface EmailTemplateRecord {
  id: string;
  template_key: string;
  name: string;
  description: string | null;
  subject: string;
  html_body: string;
  text_body: string | null;
  variables: string[];
  category: string;
}

interface AdminEmailTemplateFormProps {
  mode: "create" | "edit";
  template?: EmailTemplateRecord | null;
}

export function AdminEmailTemplateForm({ mode, template }: AdminEmailTemplateFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [templateKey, setTemplateKey] = useState(template?.template_key ?? "");
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [htmlBody, setHtmlBody] = useState(template?.html_body ?? "");
  const [textBody, setTextBody] = useState(template?.text_body ?? "");
  const [variables, setVariables] = useState<string>(template?.variables?.join(", ") ?? "");
  const [category, setCategory] = useState(template?.category ?? "general");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (mode === "edit" && template) {
      setTemplateKey(template.template_key);
      setName(template.name);
      setDescription(template.description ?? "");
      setSubject(template.subject);
      setHtmlBody(template.html_body);
      setTextBody(template.text_body ?? "");
      setVariables(template.variables.join(", "));
      setCategory(template.category);
    }
  }, [template, mode]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!templateKey || !name || !subject || !htmlBody) {
      toast({ title: "Missing fields", description: "Template key, name, subject and HTML body are required.", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        template_key: templateKey,
        name,
        description: description || null,
        subject,
        html_body: htmlBody,
        text_body: textBody || null,
        variables: variables.split(",").map((v) => v.trim()).filter(Boolean),
        category,
      };
      if (mode === "edit" && template) {
        const { error } = await supabase
          .from("platform_email_templates")
          .update(payload)
          .eq("id", template.id);
        if (error) throw error;
        toast({ title: "Template updated" });
      } else {
        const { error } = await supabase.from("platform_email_templates").insert(payload);
        if (error) throw error;
        toast({ title: "Template created" });
      }
      navigate(LIST_PATH);
    } catch (err: any) {
      toast({
        title: "Error",
        description: normalizeError(err).message || "Failed to save template",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode={mode}
      entityLabel="Email template"
      recordRef={template?.name}
      meta={
        mode === "edit"
          ? "Update template subject, body, and variables."
          : "Create a reusable email template with variable placeholders."
      }
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create template"}
    >
      <Section title="Identity" description="How this template is referenced by campaigns and automations.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="tpl-key">Template key *</Label>
            <Input id="tpl-key" placeholder="e.g., welcome_new_user" value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)} disabled={mode === "edit"} />
          </div>
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="welcome">Welcome</SelectItem>
                <SelectItem value="reengagement">Re-engagement</SelectItem>
                <SelectItem value="announcement">Announcement</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="general">General</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-name">Name *</Label>
            <Input id="tpl-name" placeholder="Template display name" value={name}
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tpl-desc">Description</Label>
            <Input id="tpl-desc" placeholder="Brief description" value={description}
              onChange={(e) => setDescription(e.target.value)} />
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Content" description="Subject line and email bodies. Use {{variable}} for placeholders.">
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="tpl-subject">Subject *</Label>
            <Input id="tpl-subject" placeholder="Email subject line" value={subject}
              onChange={(e) => setSubject(e.target.value)} />
          </div>
        </AdminFieldCell>
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="tpl-vars">Variables</Label>
            <Input id="tpl-vars" placeholder="user_name, platform_name, login_url"
              value={variables} onChange={(e) => setVariables(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of variable names (without curly braces).
            </p>
          </div>
        </AdminFieldCell>
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="tpl-html">HTML body *</Label>
            <Textarea id="tpl-html" placeholder="<div>Your HTML email content...</div>"
              value={htmlBody} onChange={(e) => setHtmlBody(e.target.value)}
              rows={14} className="font-mono text-sm" />
          </div>
        </AdminFieldCell>
        <AdminFieldCell span={2}>
          <div className="space-y-2">
            <Label htmlFor="tpl-text">Plain text body</Label>
            <Textarea id="tpl-text" placeholder="Plain text version for clients without HTML support"
              value={textBody} onChange={(e) => setTextBody(e.target.value)} rows={4} />
          </div>
        </AdminFieldCell>
      </Section>
    </AdminRecordForm>
  );
}

export default AdminEmailTemplateForm;