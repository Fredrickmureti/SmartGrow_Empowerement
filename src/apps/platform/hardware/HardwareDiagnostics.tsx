/**
 * Hardware diagnostics workspace — ADR-0100.
 *
 * Split from one endless scroll into a tabbed workspace:
 *   Overview · Devices & health · Activity · Errors & DLQ · Runtime · Support.
 *
 * The Overview + Devices tabs speak in business terms (named printers,
 * "offline / needs attention / healthy" chips). Raw runtime & registry
 * detail lives under the Runtime tab. All engineer utilities
 * (copy JSON, support-bundle download) live in Support.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import {
  runtimeReasonLabel,
  classifyError,
  shortDateTime,
  transportLabel,
} from "./lib/humanize";

interface RuntimeReasonRow {
  at: number;
  role: string;
  op: string;
  reason: RuntimeReason;
}

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
  const [tab, setTab] = useState<string>(() => {
    if (typeof window === "undefined") return "overview";
    const p = new URLSearchParams(window.location.search).get("tab");
    return p || "overview";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const p = new URLSearchParams(window.location.search);
    p.set("tab", tab);
    const next = `${window.location.pathname}?${p.toString()}`;
    window.history.replaceState(null, "", next);
  }, [tab]);

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
    <div className="space-y-4 p-4 md:p-6" data-testid="hardware-diagnostics-page">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Hardware diagnostics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Health, activity, and troubleshooting for every printer and hardware
            device on this workstation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={pos?.isElectron ? "default" : "outline"}>
            {pos?.isElectron ? "Desktop app" : "Browser"}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="devices">Devices &amp; health</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="errors">Errors &amp; DLQ</TabsTrigger>
          <TabsTrigger value="runtime">Runtime</TabsTrigger>
          <TabsTrigger value="support">Support</TabsTrigger>
        </TabsList>

        {/* ── Overview ── */}
        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <OverviewTile
              label="Runtime"
              value={pos?.isElectron ? "Desktop app" : "Browser"}
              hint={pos?.preloadBuild ? `Build ${pos.preloadBuild}` : "No preload build detected"}
              tone={pos?.isElectron ? "ok" : "info"}
            />
            <OverviewTile
              label="IoT agent"
              value={agent?.reachable ? "Reachable" : "Not reachable"}
              hint={agent?.reachable ? `${agent.devices ?? 0} devices reported` : (agent?.reason ?? "Only required for CUPS / shared LAN printers")}
              tone={agent?.reachable ? "ok" : "info"}
            />
            <OverviewTile
              label="Registry cache"
              value={
                electronRows == null
                  ? "Not applicable"
                  : hydrator.lastError
                    ? "Sync error"
                    : "In sync"
              }
              hint={
                electronRows == null
                  ? "This runtime does not use a local cache."
                  : hydrator.lastSyncAt
                    ? `Last sync ${new Date(hydrator.lastSyncAt).toLocaleTimeString()}`
                    : "Waiting for first sync"
              }
              tone={hydrator.lastError ? "warn" : "ok"}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Anything that needs attention</CardTitle>
              <CardDescription>Recent failures, grouped so you can act on categories rather than reading raw errors.</CardDescription>
            </CardHeader>
            <CardContent>
              <IssuesSummary orgId={currentOrg?.id ?? null} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Devices & health ── */}
        <TabsContent value="devices" className="space-y-4 mt-4">
          <DevicesHealthGrid orgId={currentOrg?.id ?? null} />
        </TabsContent>

        {/* ── Activity ── */}
        <TabsContent value="activity" className="space-y-4 mt-4">
          <RecentCommandsCard orgId={currentOrg?.id ?? null} />
        </TabsContent>

        {/* ── Errors & DLQ ── */}
        <TabsContent value="errors" className="space-y-4 mt-4">
          <DeadLetterQueueCard />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent errors by category</CardTitle>
              <CardDescription>Automatic root-cause grouping from the last hour of hardware activity.</CardDescription>
            </CardHeader>
            <CardContent>
              <IssuesSummary orgId={currentOrg?.id ?? null} verbose />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Runtime ── */}
        <TabsContent value="runtime" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Runtime</CardTitle>
              <CardDescription>
                Electron preload fingerprint. If <code>preloadBuild</code> is missing or older than the renderer expects, the packaged desktop app is stale.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Environment"><Badge variant={pos?.isElectron ? "default" : "outline"}>{pos?.isElectron ? "Desktop app" : "Browser"}</Badge></Row>
              <Row label="Platform">{pos?.platform ?? "—"}</Row>
              <Row label="Preload build"><code className="font-mono text-xs">{pos?.preloadBuild ?? "unknown"}</code></Row>
              <Row label="window.pos keys"><code className="font-mono text-xs">{pos ? listTopLevelKeys(pos).join(", ") : "(no window.pos)"}</code></Row>
              <Row label="Preload features"><code className="font-mono text-xs">{(pos?.preloadFeatures ?? []).join(", ") || "—"}</code></Row>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Device registries</CardTitle>
              <CardDescription>
                <code>device_assignments</code> is the single source of truth; the Electron SQLite table is a hydrated cache.
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
                  <p className="font-medium">Hydrator</p>
                  <Button size="sm" variant="outline" disabled={resyncing || !hydrator.active} onClick={() => void resyncHydrator()}>
                    {resyncing ? "Resyncing…" : "Resync now"}
                  </Button>
                </div>
                <p className="text-xs">Active: <Badge variant={hydrator.active ? "default" : "outline"}>{hydrator.active ? "yes" : "no (not desktop app)"}</Badge></p>
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Local IoT agent</CardTitle>
              <CardDescription>Only required for CUPS, Windows spooler, and browser USB when WebUSB is unavailable. Bypassed in the desktop app.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!agent ? <Skeleton className="h-4 w-40" /> : (
                <>
                  <Row label="Reachable"><Badge variant={agent.reachable ? "default" : "outline"}>{agent.reachable ? "yes" : "no"}</Badge></Row>
                  <Row label="Base URL"><code className="font-mono text-xs">{agent.baseUrl}</code></Row>
                  <Row label="Version">{agent.version ?? "—"}</Row>
                  <Row label="Devices reported">{agent.devices ?? 0}</Row>
                  {agent.reason && <Row label="Reason"><code className="font-mono text-xs">{agent.reason}</code></Row>}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Browser capabilities</CardTitle>
              <CardDescription>Native web APIs in the current runtime.</CardDescription>
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Runtime decisions (last 25)</CardTitle>
              <CardDescription>
                Which transport the resolver chose for each hardware call. "Desktop app fell back to browser" means the desktop app couldn't reach its main-process IPC — the preload bundle is stale.
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
                        <th className="text-left py-1 font-medium">Routed via</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runtimeReasons.map((r, i) => {
                        const isAnomaly = r.reason === "electron-fallback-unexpected";
                        return (
                          <tr key={`${r.at}-${i}`} className={isAnomaly ? "border-b bg-destructive/10 text-destructive" : "border-b"}>
                            <td className="py-1 pr-3 font-mono">{new Date(r.at).toLocaleTimeString()}</td>
                            <td className="py-1 pr-3 font-mono">{r.role}</td>
                            <td className="py-1 pr-3 font-mono">{r.op}</td>
                            <td className="py-1"><Badge variant={isAnomaly ? "destructive" : "outline"}>{runtimeReasonLabel(r.reason)}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Support ── */}
        <TabsContent value="support" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Support tools</CardTitle>
              <CardDescription>Utilities for the AccrualFlow support team. Operators normally do not need these.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <Button variant="outline" size="sm" onClick={() => void copyDiagnostics()}>
                  Copy diagnostics JSON
                </Button>
                <p className="text-xs text-muted-foreground mt-1">
                  Captures a redacted snapshot of runtime, registries, agent status, and the last 50 runtime decisions.
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                Documentation: <a className="underline" href="/docs/architecture/HARDWARE_RUNTIME.md" target="_blank" rel="noreferrer">HARDWARE_RUNTIME.md</a>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewTile({
  label,
  value,
  hint,
  tone = "info",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn" | "info";
}) {
  const badge = tone === "ok" ? "default" : tone === "warn" ? "destructive" : "outline";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 flex items-center gap-2">
          <Badge variant={badge as "default" | "destructive" | "outline"}>{value}</Badge>
        </div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * IssuesSummary — groups recent hardware_exec_log failures by category
 * (offline / driver-missing / permission / timeout / unknown) so the
 * operator sees "5 offline events" instead of five raw stack traces.
 */
function IssuesSummary({ orgId, verbose }: { orgId: string | null; verbose?: boolean }) {
  const [rows, setRows] = useState<Array<{ role: string; op: string; error_message: string | null; created_at: string }>>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    supabase
      .from("hardware_exec_log")
      .select("role, op, error_message, created_at")
      .eq("org_id", orgId)
      .eq("ok", false)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setRows(data ?? []);
        setLoading(false);
      });
  }, [orgId]);

  const groups = useMemo(() => {
    const g = new Map<string, { count: number; hint: string; latest: string; sample: string }>();
    for (const r of rows) {
      const c = classifyError(r.error_message);
      const entry = g.get(c.category) ?? { count: 0, hint: c.hint, latest: r.created_at, sample: c.summary };
      entry.count += 1;
      if (r.created_at > entry.latest) {
        entry.latest = r.created_at;
        entry.sample = c.summary;
      }
      g.set(c.category, entry);
    }
    return [...g.entries()].sort((a, z) => z[1].count - a[1].count);
  }, [rows]);

  if (loading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No hardware failures recorded recently. All good.</p>;

  return (
    <div className="space-y-2">
      {groups.map(([cat, info]) => (
        <div key={cat} className="rounded border p-3 flex items-start gap-3">
          <Badge variant="outline" className="mt-0.5">{cat}</Badge>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{info.count} event{info.count === 1 ? "" : "s"}</div>
            <div className="text-xs text-muted-foreground">{info.hint}</div>
            {verbose && <div className="text-xs text-muted-foreground mt-1">Latest: {shortDateTime(info.latest)} — {info.sample}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * DevicesHealthGrid — one card per named printer/device with success
 * rate, p50 latency, and last activity. Aggregates the last hour of
 * hardware_exec_log rows keyed by role, and matches to
 * device_assignments for the human name.
 */
function DevicesHealthGrid({ orgId }: { orgId: string | null }) {
  const [devices, setDevices] = useState<Array<{ id: string; display_name: string; role: string; transport: string; driver: string; enabled: boolean }>>([]);
  const [logs, setLogs] = useState<Array<{ role: string; ok: boolean; duration_ms: number | null; error_message: string | null; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    Promise.all([
      supabase.from("device_assignments").select("id, display_name, role, transport, driver, enabled"),
      supabase.from("hardware_exec_log").select("role, ok, duration_ms, error_message, created_at").eq("org_id", orgId).gte("created_at", new Date(Date.now() - 3600_000).toISOString()).limit(500),
    ]).then(([d, l]) => {
      setDevices((d.data ?? []) as typeof devices);
      setLogs((l.data ?? []) as typeof logs);
      setLoading(false);
    });
  }, [orgId]);

  const health = useMemo(() => {
    const byRole = new Map<string, { total: number; ok: number; durations: number[]; lastError: string | null; lastAt: string | null }>();
    for (const r of logs) {
      const b = byRole.get(r.role) ?? { total: 0, ok: 0, durations: [], lastError: null, lastAt: null };
      b.total += 1;
      if (r.ok) b.ok += 1;
      if (typeof r.duration_ms === "number") b.durations.push(r.duration_ms);
      if (!r.ok && r.error_message && !b.lastError) b.lastError = r.error_message;
      if (!b.lastAt || r.created_at > b.lastAt) b.lastAt = r.created_at;
      byRole.set(r.role, b);
    }
    return byRole;
  }, [logs]);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (devices.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No hardware devices have been registered yet. Add one from <a className="underline" href="/platform/hardware/devices">Hardware · Devices</a>.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {devices.map((d) => {
        const h = health.get(d.role);
        const errorRate = h && h.total > 0 ? 1 - h.ok / h.total : 0;
        const p50 = h && h.durations.length
          ? h.durations.slice().sort((a, z) => a - z)[Math.floor(h.durations.length / 2)]
          : null;
        const tone: "ok" | "warn" | "error" | "idle" = !d.enabled
          ? "idle"
          : !h
            ? "idle"
            : errorRate === 0
              ? "ok"
              : errorRate < 0.2
                ? "warn"
                : "error";
        const toneLabel = { ok: "Healthy", warn: "Some errors", error: "Failing", idle: d.enabled ? "No recent activity" : "Disabled" }[tone];
        const toneBadge = { ok: "default", warn: "secondary", error: "destructive", idle: "outline" }[tone] as "default" | "secondary" | "destructive" | "outline";
        return (
          <Card key={d.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">{d.display_name || "Unnamed device"}</div>
                  <div className="text-xs text-muted-foreground">{d.role} · {transportLabel(d.transport)}</div>
                </div>
                <Badge variant={toneBadge}>{toneLabel}</Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-muted-foreground">Ops (1h)</div><div className="font-medium">{h?.total ?? 0}</div></div>
                <div><div className="text-muted-foreground">Error rate</div><div className="font-medium">{h ? `${Math.round(errorRate * 100)}%` : "—"}</div></div>
                <div><div className="text-muted-foreground">p50</div><div className="font-medium">{p50 != null ? `${p50} ms` : "—"}</div></div>
              </div>
              {h?.lastError && (
                <p className="text-xs text-destructive truncate" title={h.lastError}>{classifyError(h.lastError).summary}</p>
              )}
              <div className="text-xs text-muted-foreground">Last activity: {h?.lastAt ? shortDateTime(h.lastAt) : "—"}</div>
            </CardContent>
          </Card>
        );
      })}
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