// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import AdminEmailTemplateForm, { type EmailTemplateRecord } from "./AdminEmailTemplateForm";

export default function AdminEmailTemplateEditPage() {
  const { id } = useParams<{ id: string }>();
  const [template, setTemplate] = useState<EmailTemplateRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    supabase
      .from("platform_email_templates")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        setTemplate((data as EmailTemplateRecord | null) ?? null);
        setIsLoading(false);
      });
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <AdminEmailTemplateForm mode="edit" template={template} />;
}