/**
 * Hardware Diagnostics — Phase 1 (truth & telemetry).
 *
 * Purpose: stop guessing why a desktop install behaves like the browser,
 * why "Test" sends bytes to nothing, or why a row visible in
 * /pos/settings hardware tab is invisible to /pos/hardware-devices.
 *
 * This page is READ-ONLY. It does not mutate any registry, does not
 * dispatch any hardware command, does not pair anything. It only
 * reflects what each subsystem reports about itself, side-by-side.
 *
 * Sections:
 *   1. Runtime — Electron vs browser, preload build fingerprint,
 *      window.pos surface shape.
 *   2. Registries — row count of canonical Supabase `device_assignments`
 *      vs the Electron SQLite hydrated cache. Wave 9b dropped the legacy
 *      `pos_hardware_configs` mirror entirely.
 *      Electron-local SQLite assignments (via window.pos.devices.list),
 *      and a diff by (role, transport, driver) tuple.
 *   3. Agent — localhost:8043 reachability, version, devices reported.
 *   4. Capabilities — WebUSB / WebSerial / WebHID support flags.
 *
 * If you are debugging a "looks fine in UI, does nothing on the wire"
 * issue, start here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import {
  hardwareClient,
  getRecentRuntimeReasons,
  type RuntimeReason,
} from "@/services/hardware/HardwareClient";
import {
  getRecentExecLog,
  type HardwareExecLogEntry,
} from "@/services/hardware/HardwareExecLog";
import {
  getHydratorStatus,
  startElectronAssignmentHydrator,
  type HydratorStatus,
} from "@/services/hardware/ElectronAssignmentHydrator";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { DeadLetterQueueCard } from "@/components/hardware/DeadLetterQueueCard";


interface RuntimeReasonRow {
  at: number;
  role: string;
  op: string;
  reason: RuntimeReason;
}

const RUNTIME_REASON_LABELS: Record<RuntimeReason, string> = {
  "electron-bypass": "Electron IPC (main process)",
  "browser-direct": "Browser adapter (WebUSB / agent)",
  "electron-fallback-unexpected": "Browser fallback inside Electron — stale preload",
};

interface PosSurface {
  isElectron?: boolean;
  platform?: string;
  preloadBuild?: string;
  preloadFeatures?: string[];
  hardware?: Record<string, unknown>;
  devices?: Record<string, unknown>;
  app?: Record<string, unknown>;
}

interface ElectronRow {
  id: number;
  role: string;
  transport: string;
  driver: string;
  enabled: number;
  terminal_id: string | null;
}

interface AssignmentRow {
  id: string;
  role: string;
  transport: string;
  driver: string;
  enabled: boolean;
}

interface AgentReport {
  reachable: boolean;
  baseUrl: string;
  version?: string | null;
  devices?: number;
  reason?: string;
}

function readPosSurface(): PosSurface | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { pos?: PosSurface };
  return w.pos ?? null;
}

function listTopLevelKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj as Record<string, unknown>).sort();
}

export default function HardwareDiagnostics() {
  const { currentOrg } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState<PosSurface | null>(null);
  const [electronRows, setElectronRows] = useState<ElectronRow[] | null>(null);
  const [electronError, setElectronError] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentReport | null>(null);
  const [assignments, setAssignments] = useState<AssignmentRow[] | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [hydrator, setHydrator] = useState<HydratorStatus>(() => getHydratorStatus());
  const [resyncing, setResyncing] = useState(false);
  const [runtimeReasons, setRuntimeReasons] = useState<RuntimeReasonRow[]>(() =>
    [...getRecentRuntimeReasons()].slice(-25).reverse(),
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setPos(readPosSurface());

    // --- Canonical registry (device_assignments) ---
    // Wave 9b: legacy `pos_hardware_configs` table and reverse-mirror
    // trigger were dropped; `device_assignments` is now the only source
    // of truth, queried directly here for the diagnostics view.
    try {
      const { data, error } = await supabase
        .from("device_assignments")
        .select("id, role, transport, driver, enabled")
        .limit(500);
      if (error) {
        setAssignmentsError(error.message);
        setAssignments([]);
      } else {
        setAssignmentsError(null);
        setAssignments((data ?? []) as AssignmentRow[]);
      }
    } catch (e) {
      setAssignmentsError((e as Error).message);
      setAssignments([]);
    }

    setHydrator(getHydratorStatus());

    // --- Electron SQLite registry (window.pos.devices.list) ---
    const w = window as unknown as {
      pos?: { devices?: { list?: () => Promise<{ ok: boolean; rows?: ElectronRow[]; error?: string }> } };
    };
    if (w.pos?.devices?.list) {
      try {
        const res = await w.pos.devices.list();
        if (!res.ok) {
          setElectronError(res.error ?? "devices.list returned ok:false");
          setElectronRows([]);
        } else {
          setElectronError(null);
          setElectronRows(res.rows ?? []);
        }
      } catch (e) {
        setElectronError((e as Error).message);
        setElectronRows([]);
      }
    } else {
      setElectronRows(null); // not applicable in browser
      setElectronError(null);
    }

    // --- Local agent reachability ---
    try {
      const status = await hardwareClient.agent.status();
      setAgent({
        reachable: status.available,
        baseUrl: status.baseUrl,
        version: status.version ?? null,
        devices: status.devices?.length ?? 0,
        reason: status.reason,
      });
    } catch (e) {
      setAgent({ reachable: false, baseUrl: "unknown", reason: (e as Error).message });
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.info("[hardware-diagnostics] mounted", {
      hasWindowPos: typeof window !== "undefined" && Boolean((window as unknown as { pos?: unknown }).pos),
    });
    void refresh();
  }, [refresh]);

  // Poll the runtime-reason ring every 2s so operators see new decisions
  // without having to hit Refresh. Cheap — in-memory slice of ≤50 entries.
  useEffect(() => {
    const tick = () => {
      setRuntimeReasons([...getRecentRuntimeReasons()].slice(-25).reverse());
    };
    tick();
    const handle = window.setInterval(tick, 2000);
    return () => window.clearInterval(handle);
  }, []);

  const copyDiagnostics = useCallback(async () => {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      runtime: pos,
      capabilities: typeof navigator !== "undefined"
        ? {
            webusb: Boolean((navigator as unknown as { usb?: unknown }).usb),
            webserial: Boolean((navigator as unknown as { serial?: unknown }).serial),
            webhid: Boolean((navigator as unknown as { hid?: unknown }).hid),
            userAgent: navigator.userAgent,
          }
        : null,
      hydrator,
      registries: {
        deviceAssignments: assignments?.length ?? null,
        electronSqlite: electronRows?.length ?? null,
      },
      agent,
      runtimeReasons: [...getRecentRuntimeReasons()],
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      toast.success("Diagnostics copied to clipboard");
    } catch (e) {
      toast.error(`Copy failed: ${(e as Error).message}`);
    }
  }, [pos, hydrator, assignments, electronRows, agent]);


  const resyncHydrator = useCallback(async () => {
    if (!currentOrg?.id) return;
    setResyncing(true);
    try {
      // start() is idempotent — re-issuing it forces a hydrateOnce + resubscribe.
      startElectronAssignmentHydrator(currentOrg.id);
      // Give the hydrator a tick to push rows into SQLite before we re-read.
      await new Promise((r) => setTimeout(r, 250));
      await refresh();
    } finally {
      setResyncing(false);
    }
  }, [currentOrg?.id, refresh]);

  const registryDiff = useMemo(() => {
    if (!assignments || !electronRows) return null;
    const key = (role: string, transport: string, driver: string) => `${role}|${transport}|${driver}`;
    const supaSet = new Set(assignments.map((r) => key(r.role, r.transport, r.driver)));
    const elSet = new Set(electronRows.map((r) => key(r.role, r.transport, r.driver)));
    const onlySupa: string[] = [];
    const onlyElectron: string[] = [];
    supaSet.forEach((k) => { if (!elSet.has(k)) onlySupa.push(k); });
    elSet.forEach((k) => { if (!supaSet.has(k)) onlyElectron.push(k); });
    return { onlySupa, onlyElectron, common: [...supaSet].filter((k) => elSet.has(k)) };
  }, [assignments, electronRows]);

  const capabilities = useMemo(() => {
    if (typeof navigator === "undefined") return null;
    const n = navigator as unknown as { usb?: unknown; serial?: unknown; hid?: unknown };
    return {
      webusb: Boolean(n.usb),
      webserial: Boolean(n.serial),
      webhid: Boolean(n.hid),
      userAgent: navigator.userAgent,
    };
  }, []);

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="hardware-diagnostics-page">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hardware diagnostics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Read-only snapshot of every hardware subsystem. Use this page when a
            device assignment is visible in the UI but does nothing on the wire,
            or when the desktop app behaves like the browser preview.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void copyDiagnostics()}>
            Copy diagnostics
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Wave 11 R2: dead-letter queue */}
      <DeadLetterQueueCard />

      {/* 1. Runtime */}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runtime</CardTitle>
          <CardDescription>
            Electron preload fingerprint. If `preloadBuild` is missing or older
            than what the renderer expects, the packaged desktop app is stale.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Environment">
            <Badge variant={pos?.isElectron ? "default" : "outline"}>
              {pos?.isElectron ? "Electron" : "Browser / PWA"}
            </Badge>
          </Row>
          <Row label="Platform">{pos?.platform ?? "—"}</Row>
          <Row label="Preload build">
            <code className="font-mono text-xs">{pos?.preloadBuild ?? "unknown (stale or browser)"}</code>
          </Row>
          <Row label="window.pos keys">
            <code className="font-mono text-xs">{pos ? listTopLevelKeys(pos).join(", ") : "(no window.pos)"}</code>
          </Row>
          <Row label="Preload features">
            <code className="font-mono text-xs">{(pos?.preloadFeatures ?? []).join(", ") || "—"}</code>
          </Row>
        </CardContent>
      </Card>

      {/* 2. Registries */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Device registries</CardTitle>
          <CardDescription>
            <code>device_assignments</code> is the single source of truth.
            The Electron SQLite assignments table is a hydrated cache, not
            a registry. (Wave 9b dropped the legacy{" "}
            <code>pos_hardware_configs</code> mirror.)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Row label="Supabase device_assignments (canonical)">
            {loading ? <Skeleton className="h-4 w-12" /> :
              assignmentsError ? <span className="text-destructive">error: {assignmentsError}</span> :
              <Badge>{assignments?.length ?? 0} rows</Badge>}
          </Row>
          <Row label="Electron SQLite assignments">
            {electronRows === null ? <span className="text-muted-foreground">not applicable (browser)</span> :
              loading ? <Skeleton className="h-4 w-12" /> :
              electronError ? <span className="text-destructive">error: {electronError}</span> :
              <Badge variant="outline">{electronRows.length} rows</Badge>}
          </Row>
          <div className="rounded border p-3 space-y-1 bg-muted/40">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Hydrator (device_assignments → SQLite cache)</p>
              <Button
                size="sm"
                variant="outline"
                disabled={resyncing || !hydrator.active}
                onClick={() => void resyncHydrator()}
              >
                {resyncing ? "Resyncing…" : "Resync now"}
              </Button>
            </div>
            <p className="text-xs">Active: <Badge variant={hydrator.active ? "default" : "outline"}>{hydrator.active ? "yes" : "no (not Electron)"}</Badge></p>
            <p className="text-xs">Last sync: <code>{hydrator.lastSyncAt ? new Date(hydrator.lastSyncAt).toLocaleTimeString() : "—"}</code></p>
            <p className="text-xs">Rows hydrated: <code>{hydrator.rowsHydrated}</code></p>
            {hydrator.lastError && <p className="text-xs text-destructive">Last error: <code>{hydrator.lastError}</code></p>}
          </div>
          {registryDiff && (
            <div className="rounded border p-3 space-y-1 bg-muted/40">
              <p className="font-medium">Diff by (role, transport, driver)</p>
              <p className="text-xs">In Supabase only: <code>{registryDiff.onlySupa.length ? registryDiff.onlySupa.join(" · ") : "—"}</code></p>
              <p className="text-xs">In Electron only: <code>{registryDiff.onlyElectron.length ? registryDiff.onlyElectron.join(" · ") : "—"}</code></p>
              <p className="text-xs">In both: <code>{registryDiff.common.length || "—"}</code></p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Agent */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Local IoT agent</CardTitle>
          <CardDescription>
            Only required for CUPS, Windows spooler, and browser USB printing
            when WebUSB drivers are unavailable. Bypassed in Electron.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {!agent ? <Skeleton className="h-4 w-40" /> : (
            <>
              <Row label="Reachable">
                <Badge variant={agent.reachable ? "default" : "outline"}>{agent.reachable ? "yes" : "no"}</Badge>
              </Row>
              <Row label="Base URL"><code className="font-mono text-xs">{agent.baseUrl}</code></Row>
              <Row label="Version">{agent.version ?? "—"}</Row>
              <Row label="Devices reported">{agent.devices ?? 0}</Row>
              {agent.reason && <Row label="Reason"><code className="font-mono text-xs">{agent.reason}</code></Row>}
            </>
          )}
        </CardContent>
      </Card>

      {/* 4. Capabilities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Browser capabilities</CardTitle>
          <CardDescription>Native web APIs available in the current runtime.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {capabilities ? (
            <>
              <Row label="WebUSB"><Badge variant={capabilities.webusb ? "default" : "outline"}>{capabilities.webusb ? "supported" : "no"}</Badge></Row>
              <Row label="Web Serial"><Badge variant={capabilities.webserial ? "default" : "outline"}>{capabilities.webserial ? "supported" : "no"}</Badge></Row>
              <Row label="WebHID"><Badge variant={capabilities.webhid ? "default" : "outline"}>{capabilities.webhid ? "supported" : "no"}</Badge></Row>
              <Row label="User agent"><code className="font-mono text-xs break-all">{capabilities.userAgent}</code></Row>
            </>
          ) : <span className="text-muted-foreground">unavailable</span>}
        </CardContent>
      </Card>

      {/* 5. Runtime decisions — Wave 7 observability slice */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Runtime decisions (last 25)</CardTitle>
          <CardDescription>
            Every hardware call records which transport the resolver picked.
            <code className="ml-1">electron-fallback-unexpected</code> means
            the desktop app couldn't reach its main-process IPC — usually a
            stale preload bundle (see Hardware Runtime docs).
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {runtimeReasons.length === 0 ? (
            <span className="text-muted-foreground">No hardware calls yet this session.</span>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-1 pr-3 font-medium">Time</th>
                    <th className="text-left py-1 pr-3 font-medium">Role</th>
                    <th className="text-left py-1 pr-3 font-medium">Op</th>
                    <th className="text-left py-1 font-medium">Transport</th>
                  </tr>
                </thead>
                <tbody>
                  {runtimeReasons.map((r, i) => {
                    const isAnomaly = r.reason === "electron-fallback-unexpected";
                    return (
                      <tr
                        key={`${r.at}-${i}`}
                        className={isAnomaly ? "border-b bg-destructive/10 text-destructive" : "border-b"}
                        title={isAnomaly
                          ? "Electron detected but main-process IPC unavailable. Repackage the desktop app to refresh the preload bundle."
                          : RUNTIME_REASON_LABELS[r.reason]}
                      >
                        <td className="py-1 pr-3 font-mono">{new Date(r.at).toLocaleTimeString()}</td>
                        <td className="py-1 pr-3 font-mono">{r.role}</td>
                        <td className="py-1 pr-3 font-mono">{r.op}</td>
                        <td className="py-1">
                          <Badge variant={isAnomaly ? "destructive" : "outline"}>
                            {RUNTIME_REASON_LABELS[r.reason]}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 6. Recent hardware commands — Phase 3 audit-log slice.
          Hybrid view: prefers Supabase `hardware_exec_log` (tenant-scoped
          via RLS), falls back to the in-memory ring buffer when the table
          is empty or unreachable. */}
      <RecentCommandsCard orgId={currentOrg?.id ?? null} />
    </div>
  );
}

interface ExecLogRow {
  at: number;
  role: string;
  op: string;
  ok: boolean;
  durationMs: number | null;
  errorMessage: string | null;
  runtimeReason: string | null;
  source: 'db' | 'ring';
}

function RecentCommandsCard({ orgId }: { orgId: string | null }) {
  const [rows, setRows] = useState<ExecLogRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    let dbRows: ExecLogRow[] = [];
    if (orgId) {
      try {
        const { data, error } = await supabase
          .from('hardware_exec_log')
          .select('role, op, ok, duration_ms, error_message, runtime_reason, created_at')
          .eq('org_id', orgId)
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) setLoadError(error.message);
        else {
          dbRows = (data ?? []).map((r) => ({
            at: new Date(r.created_at).getTime(),
            role: r.role,
            op: r.op,
            ok: r.ok,
            durationMs: r.duration_ms,
            errorMessage: r.error_message,
            runtimeReason: r.runtime_reason,
            source: 'db' as const,
          }));
        }
      } catch (e) {
        setLoadError((e as Error).message);
      }
    }
    if (dbRows.length === 0) {
      const ring = getRecentExecLog();
      dbRows = ring
        .slice()
        .reverse()
        .map((r: HardwareExecLogEntry) => ({
          at: r.at,
          role: r.role,
          op: r.op,
          ok: r.ok,
          durationMs: r.durationMs,
          errorMessage: r.errorMessage ?? null,
          runtimeReason: r.runtimeReason ?? null,
          source: 'ring' as const,
        }));
    }
    setRows(dbRows);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void load();
    const handle = window.setInterval(() => void load(), 10_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(handle);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const roles = useMemo(() => {
    const s = new Set<string>();
    (rows ?? []).forEach((r) => s.add(r.role));
    return [...s].sort();
  }, [rows]);

  const filtered = useMemo(
    () => (roleFilter ? (rows ?? []).filter((r) => r.role === roleFilter) : rows ?? []),
    [rows, roleFilter],
  );

  // Per-role health derived from rows in the last hour.
  const health = useMemo(() => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const buckets = new Map<string, { total: number; ok: number; durations: number[]; lastError: string | null }>();
    (rows ?? []).forEach((r) => {
      if (r.at < cutoff) return;
      const b = buckets.get(r.role) ?? { total: 0, ok: 0, durations: [], lastError: null };
      b.total += 1;
      if (r.ok) b.ok += 1;
      if (typeof r.durationMs === 'number') b.durations.push(r.durationMs);
      if (!r.ok && r.errorMessage && !b.lastError) b.lastError = r.errorMessage;
      buckets.set(r.role, b);
    });
    return [...buckets.entries()].map(([role, b]) => {
      const sorted = b.durations.slice().sort((a, z) => a - z);
      const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      return {
        role,
        total: b.total,
        errorRate: b.total === 0 ? 0 : 1 - b.ok / b.total,
        p50,
        lastError: b.lastError,
      };
    }).sort((a, z) => a.role.localeCompare(z.role));
  }, [rows]);

  return (
    <Card data-testid="hardware-exec-log-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Recent hardware commands</CardTitle>
          <CardDescription>
            Every `hardwareClient.exec` call is appended to
            `hardware_exec_log` (tenant-scoped via RLS) and an in-memory
            ring. Use this to answer "did this print actually leave the app?".
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loadError && <p className="text-xs text-destructive">DB read failed: {loadError} — showing ring buffer.</p>}

        {/* Per-role health (last hour) */}
        {health.length > 0 && (
          <div className="rounded border p-3 bg-muted/40">
            <p className="font-medium mb-2">Per-role health (last hour)</p>
            <div className="flex flex-wrap gap-2">
              {health.map((h) => {
                const errPct = Math.round(h.errorRate * 100);
                const variant = h.errorRate === 0 ? "default" : h.errorRate < 0.2 ? "outline" : "destructive";
                return (
                  <Badge
                    key={h.role}
                    variant={variant as "default" | "outline" | "destructive"}
                    title={h.lastError ? `Last error: ${h.lastError}` : "Healthy"}
                    className="cursor-default"
                  >
                    {h.role}: {h.total} ops · {errPct}% err{h.p50 != null ? ` · p50 ${h.p50}ms` : ""}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        {/* Role filter chips */}
        {roles.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter:</span>
            <button
              type="button"
              className={`text-xs px-2 py-0.5 rounded border ${roleFilter === null ? "bg-foreground text-background" : ""}`}
              onClick={() => setRoleFilter(null)}
            >
              all
            </button>
            {roles.map((r) => (
              <button
                key={r}
                type="button"
                className={`text-xs px-2 py-0.5 rounded border ${roleFilter === r ? "bg-foreground text-background" : ""}`}
                onClick={() => setRoleFilter(r)}
              >
                {r}
              </button>
            ))}
          </div>
        )}

        {/* Table */}
        {rows === null ? (
          <Skeleton className="h-20 w-full" />
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No hardware commands recorded yet. Dispatch a test from the Hardware devices page.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-1 pr-3 font-medium">Time</th>
                  <th className="text-left py-1 pr-3 font-medium">Role</th>
                  <th className="text-left py-1 pr-3 font-medium">Op</th>
                  <th className="text-left py-1 pr-3 font-medium">Result</th>
                  <th className="text-left py-1 pr-3 font-medium">Duration</th>
                  <th className="text-left py-1 pr-3 font-medium">Source</th>
                  <th className="text-left py-1 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={`${r.at}-${i}`} className="border-b">
                    <td className="py-1 pr-3 font-mono">{new Date(r.at).toLocaleTimeString()}</td>
                    <td className="py-1 pr-3 font-mono">{r.role}</td>
                    <td className="py-1 pr-3 font-mono">{r.op}</td>
                    <td className="py-1 pr-3">
                      <Badge variant={r.ok ? "default" : "destructive"}>{r.ok ? "ok" : "fail"}</Badge>
                    </td>
                    <td className="py-1 pr-3 font-mono">{r.durationMs != null ? `${r.durationMs}ms` : "—"}</td>
                    <td className="py-1 pr-3">
                      <Badge variant="outline">{r.source}</Badge>
                    </td>
                    <td className="py-1 text-destructive truncate max-w-[280px]" title={r.errorMessage ?? ""}>
                      {r.errorMessage ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}