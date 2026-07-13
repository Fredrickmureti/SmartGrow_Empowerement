// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Loader2 } from "lucide-react";
import AdminEmailComposePage from "../email-center/AdminEmailComposePage";

interface DemoRequest {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
  message: string | null;
  status: string;
}

const LIST_PATH = "/admin-management/demo-requests";

export default function AdminDemoRequestReplyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [request, setRequest] = useState<DemoRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    supabase
      .from("demo_requests")
      .select("id, full_name, email, company_name, message, status")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        setRequest((data as DemoRequest | null) ?? null);
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
  if (!request) {
    return <div className="p-8 text-sm text-muted-foreground">Demo request not found.</div>;
  }

  const firstName = request.full_name.split(" ")[0] || "there";
  const defaultSubject = `Re: Your AccrualFlow Demo Request${request.company_name ? ` — ${request.company_name}` : ""}`;
  const defaultBody = `Hi ${firstName},\n\nThanks for requesting a demo of AccrualFlow${request.company_name ? ` for ${request.company_name}` : ""}. I'd love to set up a time to walk you through the platform.\n\n${request.message ? `You mentioned:\n"${request.message}"\n\n` : ""}A few times that work on my side — let me know which suits you best, or feel free to suggest another slot.\n\nBest,\nThe AccrualFlow Team`;

  const handleSent = async () => {
    if (request.status === "pending") {
      await supabase
        .from("demo_requests")
        .update({ status: "contacted", contacted_at: new Date().toISOString() })
        .eq("id", request.id);
    }
    navigate(LIST_PATH);
  };

  return (
    <AdminEmailComposePage
      defaultTo={request.email}
      defaultSubject={defaultSubject}
      defaultBody={defaultBody}
      lockTo
      title={`Reply to ${request.full_name}`}
      meta="Reply directly without leaving the platform. Attachments and AI assist are supported."
      cancelHref={LIST_PATH}
      logMetadata={{
        source: "demo_request",
        demo_request_id: request.id,
        recipient_name: request.full_name,
        company_name: request.company_name,
      }}
      onSent={handleSent}
    />
  );
}