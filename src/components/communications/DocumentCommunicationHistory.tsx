import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Mail, MessageSquare, AlertCircle, Clock, CheckCircle2, XCircle, Bot, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "date-fns";

interface Props {
  entityType: string;
  entityId: string;
  organizationId?: string | null;
  className?: string;
  /** Show empty state explicitly (default: hide entire pane when empty). */
  showEmpty?: boolean;
}

type Item = {
  id: string;
  channel: "sms" | "email";
  recipient: string;
  status: string;
  body?: string | null;
  error?: string | null;
  triggered_by?: string | null;
  template_name?: string | null;
  created_at: string;
  sent_by?: string | null;
};

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "sent" || s === "delivered" || s === "ok") {
    return <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />{status}</Badge>;
  }
  if (s === "failed" || s === "undelivered" || s === "error") {
    return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />{status}</Badge>;
  }
  if (s === "queued" || s === "processing" || s === "pending") {
    return <Badge variant="secondary" className="gap-1"><Clock className="h-3 w-3" />{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

/**
 * Unified communication history for any document.
 * Reads `sms_log` (SMS sends) and `document_emails` (email sends)
 * scoped to (entity_type, entity_id), merged and time-sorted.
 */
export function DocumentCommunicationHistory({ entityType, entityId, organizationId, className, showEmpty }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["doc-comm-history", entityType, entityId, organizationId],
    enabled: !!entityType && !!entityId,
    queryFn: async (): Promise<Item[]> => {
      const items: Item[] = [];

      const smsQuery = supabase
        .from("sms_log")
        .select("id, recipient_phone, status, message_body, error_message, triggered_by, created_at, sent_by, sms_templates(name)")
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("is_test", false)
        .order("created_at", { ascending: false })
        .limit(50);
      const { data: smsRows } = organizationId
        ? await smsQuery.eq("organization_id", organizationId)
        : await smsQuery;
      for (const r of (smsRows || []) as Array<Record<string, unknown>>) {
        items.push({
          id: r.id as string,
          channel: "sms",
          recipient: r.recipient_phone as string,
          status: r.status as string,
          body: r.message_body as string,
          error: r.error_message as string | null,
          triggered_by: r.triggered_by as string | null,
          template_name: (r.sms_templates as { name?: string } | null)?.name ?? null,
          created_at: r.created_at as string,
          sent_by: r.sent_by as string | null,
        });
      }

      // Best-effort email history; document_emails may or may not be scoped exactly the same way
      try {
        const { data: emailRows } = await supabase
          .from("document_emails")
          .select("id, recipient_email, status, error_message, created_at, sent_by")
          .eq("document_type", entityType)
          .eq("document_id", entityId)
          .order("created_at", { ascending: false })
          .limit(50);
        for (const r of (emailRows || []) as Array<Record<string, unknown>>) {
          items.push({
            id: r.id as string,
            channel: "email",
            recipient: r.recipient_email as string,
            status: (r.status as string) || "sent",
            error: (r.error_message as string) || null,
            created_at: r.created_at as string,
            sent_by: (r.sent_by as string) || null,
          });
        }
      } catch {
        // table may not have these exact columns in every install
      }

      items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return items;
    },
    staleTime: 30_000,
  });

  if (isLoading) return null;
  const items = data || [];
  if (items.length === 0 && !showEmpty) return null;

  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Communication history
        </h4>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No messages sent yet.</p>
      ) : (
        <ScrollArea className="max-h-56 rounded border">
          <ul className="divide-y">
            {items.map((it) => {
              const Icon = it.channel === "sms" ? MessageSquare : Mail;
              const Trigger = it.triggered_by === "automation" ? Bot : UserIcon;
              return (
                <li key={`${it.channel}-${it.id}`} className="px-3 py-2 text-sm flex items-start gap-2">
                  <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate">{it.recipient}</span>
                      {statusBadge(it.status)}
                      {it.template_name && (
                        <span className="text-xs text-muted-foreground">· {it.template_name}</span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                        <Trigger className="h-3 w-3" />
                        {formatDistanceToNow(new Date(it.created_at), { addSuffix: true })}
                      </span>
                    </div>
                    {it.body && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{it.body}</p>
                    )}
                    {it.error && (
                      <p className="text-xs text-destructive mt-1 flex items-start gap-1">
                        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                        {it.error}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}