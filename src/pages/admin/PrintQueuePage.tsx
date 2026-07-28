/**
 * PrintQueuePage — ADR-0090 · Phase D3 operator surface for `print_jobs`.
 *
 * Every physical print (thermal, PDF, ZPL) writes a row here before the
 * driver runs. This page lets an operator:
 *   - See queue depth / failure rate at a glance
 *   - Filter by status/intent/format
 *   - Re-dispatch a failed row (creates a child job via `print_job_resend`)
 *   - Manually mark a stalled row as acked when a physical inspection
 *     confirms the label came out (rare — used to unstick alerts)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { resendJob } from '@/services/printing/jobs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useBusinesses } from '@/hooks/useBusinesses';
import { Loader2, RefreshCw, Printer, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type JobStatus = 'queued' | 'sent' | 'acked' | 'failed' | 'abandoned';

interface PrintJob {
  id: string;
  business_id: string;
  branch_id: string | null;
  doc_type: string;
  doc_id: string | null;
  intent: string;
  format: string;
  transport: string;
  status: JobStatus;
  attempt_count: number;
  correlation_id: string;
  requested_at: string;
  sent_at: string | null;
  acked_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  hw_command_id: number | null;
  parent_job_id: string | null;
}

const STATUS_FILTERS: (JobStatus | 'all' | 'active')[] = ['active', 'failed', 'acked', 'all'];

const STATUS_BADGE: Record<JobStatus, { variant: 'default' | 'destructive' | 'secondary' | 'outline'; label: string }> = {
  queued:    { variant: 'secondary',   label: 'queued'    },
  sent:      { variant: 'default',     label: 'sent'      },
  acked:     { variant: 'outline',     label: 'delivered' },
  failed:    { variant: 'destructive', label: 'failed'    },
  abandoned: { variant: 'destructive', label: 'abandoned' },
};

export default function PrintQueuePage() {
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const orgId = currentBusiness?.id;

  const [rows, setRows] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('active');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      let q = supabase
        .from('print_jobs')
        .select('id, business_id, branch_id, doc_type, doc_id, intent, format, transport, status, attempt_count, correlation_id, requested_at, sent_at, acked_at, failed_at, last_error, hw_command_id, parent_job_id')
        .eq('business_id', orgId)
        .order('requested_at', { ascending: false })
        .limit(200);
      if (filter === 'active') q = q.in('status', ['queued', 'sent']);
      else if (filter !== 'all') q = q.eq('status', filter);
      const { data, error } = await q;
      if (error) throw error;
      setRows((data ?? []) as PrintJob[]);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load print queue', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [orgId, filter, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const counters = useMemo(() => {
    const c = { queued: 0, sent: 0, failed: 0, acked: 0, abandoned: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  async function handleResend(id: string) {
    setBusyId(id);
    try {
      await resendJob(id);
      toast({ title: 'Re-dispatch queued', description: 'A follow-up job was created — check status momentarily.' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Re-dispatch failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Printer className="h-6 w-6" /> Print Queue
          </h1>
          <p className="text-sm text-muted-foreground">
            Delivery ledger for every physical print — thermal, label, PDF. ADR-0090.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard icon={<Clock className="h-4 w-4" />}          label="Queued"     value={counters.queued} />
        <StatCard icon={<Printer className="h-4 w-4" />}        label="Sent"       value={counters.sent} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />}   label="Delivered"  value={counters.acked} />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />}  label="Failed"     value={counters.failed} tone="destructive" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />}  label="Abandoned"  value={counters.abandoned} tone="destructive" />
      </div>

      <div className="flex gap-2 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Jobs ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Document</th>
                  <th className="px-3 py-2">Intent</th>
                  <th className="px-3 py-2">Format</th>
                  <th className="px-3 py-2">Transport</th>
                  <th className="px-3 py-2">Attempts</th>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">Error</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">No jobs match this filter.</td></tr>
                )}
                {rows.map((r) => {
                  const badge = STATUS_BADGE[r.status];
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2"><Badge variant={badge.variant}>{badge.label}</Badge></td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <div>{r.doc_type}</div>
                        <div className="text-muted-foreground truncate max-w-[180px]">{r.doc_id ?? '—'}</div>
                      </td>
                      <td className="px-3 py-2">{r.intent}</td>
                      <td className="px-3 py-2">{r.format}</td>
                      <td className="px-3 py-2">{r.transport}</td>
                      <td className="px-3 py-2 text-center">{r.attempt_count}</td>
                      <td className="px-3 py-2 whitespace-nowrap" title={r.requested_at}>
                        {formatDistanceToNow(new Date(r.requested_at), { addSuffix: true })}
                      </td>
                      <td className="px-3 py-2 text-destructive max-w-[240px] truncate" title={r.last_error ?? ''}>
                        {r.last_error ?? ''}
                      </td>
                      <td className="px-3 py-2">
                        {(r.status === 'failed' || r.status === 'abandoned') && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyId === r.id}
                            onClick={() => handleResend(r.id)}
                          >
                            {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Resend'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'destructive' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${tone === 'destructive' && value > 0 ? 'text-destructive' : ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
