import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Activity, MessageSquare, Inbox, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface HealthRow {
  last_inbound_at: string | null;
  last_status_callback_at: string | null;
  inbound_24h: number;
  outbound_24h: number;
}

interface QueueStats {
  queued: number;
  processing: number;
  failed_24h: number;
}

/**
 * Webhook + queue health card. Surfaces:
 *  - Last time Twilio called our inbound webhook (signals webhook URL is wired)
 *  - Last delivery status callback (signals StatusCallback URL is wired)
 *  - 24h inbound + outbound counts
 *  - sms_event_outbox queue depth (queued + processing)
 *  - Failed sends in last 24h
 */
export function SmsWebhookHealthCard() {
  const { currentOrg: organization } = useOrganization();
  const [health, setHealth] = useState<HealthRow | null>(null);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organization?.id) return;
    let cancelled = false;
    (async () => {
      const [{ data: healthRows }, { count: queued }, { count: processing }, { count: failed }] = await Promise.all([
        supabase.from("sms_webhook_health" as any).select("*").eq("organization_id", organization.id),
        supabase.from("sms_event_outbox").select("id", { count: "exact", head: true }).eq("organization_id", organization.id).eq("status", "queued"),
        supabase.from("sms_event_outbox").select("id", { count: "exact", head: true }).eq("organization_id", organization.id).eq("status", "processing"),
        supabase.from("sms_log").select("id", { count: "exact", head: true })
          .eq("organization_id", organization.id)
          .eq("status", "failed")
          .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      ]);
      if (cancelled) return;
      const merged: HealthRow = (healthRows ?? []).reduce<HealthRow>((acc: HealthRow, r: any) => ({
        last_inbound_at: maxIso(acc.last_inbound_at, r.last_inbound_at),
        last_status_callback_at: maxIso(acc.last_status_callback_at, r.last_status_callback_at),
        inbound_24h: acc.inbound_24h + (r.inbound_24h ?? 0),
        outbound_24h: acc.outbound_24h + (r.outbound_24h ?? 0),
      }), { last_inbound_at: null, last_status_callback_at: null, inbound_24h: 0, outbound_24h: 0 });
      setHealth(merged);
      setQueue({ queued: queued ?? 0, processing: processing ?? 0, failed_24h: failed ?? 0 });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [organization?.id]);

  if (loading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" /> Webhook & Queue Health
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat icon={<Inbox className="h-3.5 w-3.5" />} label="Last inbound" value={fmtAgo(health?.last_inbound_at)} hint={health?.last_inbound_at ? null : "Webhook URL may not be set in Twilio Console"} />
        <Stat icon={<MessageSquare className="h-3.5 w-3.5" />} label="Last callback" value={fmtAgo(health?.last_status_callback_at)} hint={health?.last_status_callback_at ? null : "No StatusCallback received yet"} />
        <Stat icon={<MessageSquare className="h-3.5 w-3.5" />} label="24h sent" value={String(health?.outbound_24h ?? 0)} />
        <Stat icon={<Inbox className="h-3.5 w-3.5" />} label="24h received" value={String(health?.inbound_24h ?? 0)} />
        <Stat icon={<Activity className="h-3.5 w-3.5" />} label="Queued" value={String(queue?.queued ?? 0)} warn={(queue?.queued ?? 0) > 50} />
        <Stat icon={<Activity className="h-3.5 w-3.5" />} label="Processing" value={String(queue?.processing ?? 0)} />
        <Stat icon={<AlertTriangle className="h-3.5 w-3.5" />} label="24h failed" value={String(queue?.failed_24h ?? 0)} warn={(queue?.failed_24h ?? 0) > 0} />
      </CardContent>
    </Card>
  );
}

function Stat({ icon, label, value, hint, warn }: { icon: React.ReactNode; label: string; value: string; hint?: string | null; warn?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</div>
      <div className={`font-medium ${warn ? "text-destructive" : ""}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return "—"; }
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
