/**
 * HardwareOpsPage — operator surface for the business-event outbox.
 *
 * Lists failed / stuck rows from `business_event_outbox` and surfaces:
 *   - Retry button → `retry_failed_business_event`
 *   - Reclaim stuck running rows → `reclaim_stale_business_events`
 *   - Live counters from `v_business_event_outbox_health`
 *   - Print-recovery sweeper activity from `getRecoveryStatus()`
 *
 * Visibility: admin/owner — RPC is server-side gated.
 */
// @ts-nocheck
import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useBusinesses } from '@/hooks/useBusinesses';
import { Loader2, RefreshCw, RotateCcw, Activity, AlertTriangle, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { getRecoveryStatus, sweepAbandonedPrintJobs } from '@/services/printing/recovery';

interface OutboxRow {
  id: string;
  event_type: string;
  source_doc_type: string;
  source_doc_id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  branch_id: string | null;
  source: string | null;
  worker_id: string | null;
  claimed_at: string | null;
}

interface Health {
  failed_count: number;
  pending_over_5min: number;
  stale_running: number;
  oldest_pending_age_seconds: number;
}

export default function HardwareOpsPage() {
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const orgId = currentBusiness?.id;

  const [rows, setRows] = useState<OutboxRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [workerStatus, setWorkerStatus] = useState(getRecoveryStatus());
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [rowsRes, healthRes] = await Promise.all([
        supabase
          .from('business_event_outbox')
          .select('id, event_type, source_doc_type, source_doc_id, status, attempts, last_error, created_at, updated_at, branch_id, source, worker_id, claimed_at')
          .eq('org_id', orgId)
          .in('status', ['failed', 'pending', 'running'])
          .order('updated_at', { ascending: false })
          .limit(100),
        supabase
          .from('v_business_event_outbox_health')
          .select('*')
          .eq('org_id', orgId)
          .maybeSingle(),
      ]);
      if (rowsRes.error) throw rowsRes.error;
      setRows((rowsRes.data ?? []) as OutboxRow[]);
      setHealth((healthRes.data as Health) ?? { failed_count: 0, pending_over_5min: 0, stale_running: 0, oldest_pending_age_seconds: 0 });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [orgId, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    const w = setInterval(() => setWorkerStatus(getRecoveryStatus()), 3_000);
    return () => { clearInterval(t); clearInterval(w); };
  }, [load]);

  async function handleRetry(id: string) {
    setRetrying(id);
    try {
      const { error } = await supabase.rpc('retry_failed_business_event', { p_event_id: id });
      if (error) throw error;
      toast({ title: 'Retry scheduled' });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Retry failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setRetrying(null);
    }
  }

  async function handleReclaim() {
    setReclaiming(true);
    try {
      const { data, error } = await supabase.rpc('reclaim_stale_business_events');
      if (error) throw error;
      const n = Array.isArray(data) ? data.length : 0;
      toast({ title: `Reclaimed ${n} stale event${n === 1 ? '' : 's'}` });
      await load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reclaim failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReclaiming(false);
    }
  }

  const filteredFailed = useMemo(() => rows.filter(r => r.status === 'failed'), [rows]);
  const filteredOther = useMemo(() => rows.filter(r => r.status !== 'failed'), [rows]);

  if (!orgId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a business to view hardware ops.</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Hardware Ops</h1>
          <p className="text-sm text-muted-foreground">Monitor the business event queue and reprocess stuck operations.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleReclaim} disabled={reclaiming}>
            {reclaiming ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
            Reclaim stale
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Health strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthCard icon={AlertTriangle} label="Failed" value={health?.failed_count ?? 0} tone={health?.failed_count ? 'danger' : 'ok'} />
        <HealthCard icon={Clock} label="Pending > 5min" value={health?.pending_over_5min ?? 0} tone={health?.pending_over_5min ? 'warn' : 'ok'} />
        <HealthCard icon={Activity} label="Stale running" value={health?.stale_running ?? 0} tone={health?.stale_running ? 'warn' : 'ok'} />
        <HealthCard icon={Clock} label="Oldest pending" value={`${Math.floor((health?.oldest_pending_age_seconds ?? 0) / 60)}m`} tone="info" />
      </div>

      {/* Print recovery sweeper */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Print recovery sweeper</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <p className="text-muted-foreground text-xs">
            Normal prints dispatch immediately from the session that requested
            them. This sweeper only re-dispatches ledger rows abandoned by a
            session that closed mid-print.
          </p>
          {workerStatus ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div><span className="text-muted-foreground">State:</span> {workerStatus.running ? <Badge>Sweeping</Badge> : <Badge variant="secondary">Idle</Badge>}</div>
              <div><span className="text-muted-foreground">Recovered:</span> {workerStatus.recovered}</div>
              <div><span className="text-muted-foreground">Failed:</span> {workerStatus.failed}</div>
              <div>
                <span className="text-muted-foreground">Last sweep:</span>{' '}
                {workerStatus.lastSweepAt
                  ? formatDistanceToNow(workerStatus.lastSweepAt, { addSuffix: true })
                  : <em className="text-muted-foreground">never</em>}
              </div>
              <div><span className="text-muted-foreground">Up since:</span> {formatDistanceToNow(workerStatus.startedAt, { addSuffix: true })}</div>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Sweeper not running on this tab.</p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={sweeping || !orgId}
            onClick={async () => {
              if (!orgId) return;
              setSweeping(true);
              try {
                const res = await sweepAbandonedPrintJobs(orgId);
                toast({ title: `Recovered ${res.recovered} job${res.recovered === 1 ? '' : 's'}`, description: res.failed ? `${res.failed} still failing` : undefined });
              } catch (e) {
                toast({ variant: 'destructive', title: 'Replay failed', description: e instanceof Error ? e.message : String(e) });
              } finally {
                setSweeping(false);
              }
            }}
          >
            {sweeping ? 'Replaying…' : 'Replay abandoned print jobs'}
          </Button>
        </CardContent>
      </Card>

      {/* Failed rows */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Failed events ({filteredFailed.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filteredFailed.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground text-center">No failed events.</p>
          ) : (
            <div className="divide-y">
              {filteredFailed.map((r) => (
                <OutboxRowItem key={r.id} row={r} retrying={retrying === r.id} onRetry={() => handleRetry(r.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Other (pending / running) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">In progress / pending ({filteredOther.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {filteredOther.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground text-center">No active events.</p>
          ) : (
            <div className="divide-y">
              {filteredOther.map((r) => (
                <OutboxRowItem key={r.id} row={r} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HealthCard({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number | string; tone: 'ok' | 'warn' | 'danger' | 'info' }) {
  const toneClass = tone === 'danger' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600' : tone === 'info' ? 'text-muted-foreground' : 'text-emerald-600';
  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
        </div>
        <Icon className={`h-5 w-5 ${toneClass}`} />
      </CardContent>
    </Card>
  );
}

function OutboxRowItem({ row, retrying, onRetry }: { row: OutboxRow; retrying?: boolean; onRetry?: () => void }) {
  return (
    <div className="px-6 py-3 flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <code className="text-xs font-mono">{row.event_type}</code>
          <Badge variant={row.status === 'failed' ? 'destructive' : row.status === 'running' ? 'default' : 'secondary'}>
            {row.status}
          </Badge>
          {row.source && <Badge variant="outline" className="text-[10px]">{row.source}</Badge>}
          <span className="text-xs text-muted-foreground">attempts: {row.attempts}</span>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {row.source_doc_type}/{row.source_doc_id} · {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
        </p>
        {row.last_error && <p className="text-xs text-destructive mt-1 truncate">{row.last_error}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Retry'}
        </Button>
      )}
    </div>
  );
}
