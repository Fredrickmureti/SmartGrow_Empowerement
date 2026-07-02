/**
 * ScannerTelemetry — operational viewer for the `scan_events` table.
 *
 * Wave 2 wired up server-side telemetry but the table had no read surface;
 * this page is that surface. Calls `public.list_scan_events(...)` (server-
 * side cap 500, codes are masked beyond the first 4 chars), respects the
 * underlying RLS policies, and filters by register + verdict from the UI.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ScanEventRow {
  id: string;
  received_at: string;
  decoded_at: string | null;
  register_id: string | null;
  session_id: string | null;
  device_id: string | null;
  source: string | null;
  code_masked: string | null;
  verdict: string | null;
  workflow: string | null;
  latency_ms: number | null;
}

const VERDICT_OPTIONS = ["all", "ok", "weighted", "unknown", "error"] as const;
type VerdictFilter = typeof VERDICT_OPTIONS[number];

function verdictStyle(v: string | null): string {
  switch (v) {
    case "ok":
    case "weighted":
      return "bg-emerald-500/10 text-emerald-600 border-emerald-500/30";
    case "unknown":
      return "bg-amber-500/10 text-amber-600 border-amber-500/30";
    case "error":
      return "bg-red-500/10 text-red-600 border-red-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export default function ScannerTelemetryPage() {
  const [rows, setRows] = useState<ScanEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verdict, setVerdict] = useState<VerdictFilter>("all");
  const [registerFilter, setRegisterFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const load = useMemo(() => async () => {
    setLoading(true); setError(null);
    const { data, error } = await supabase.rpc("list_scan_events" as any, {
      p_limit: 200,
      p_register: registerFilter || null,
      p_verdict: verdict === "all" ? null : verdict,
    } as any);
    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      setRows(((data as unknown) as ScanEventRow[]) ?? []);
    }
    setLoading(false);
  }, [verdict, registerFilter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scanner telemetry</h1>
          <p className="text-sm text-muted-foreground">
            Last 200 scan events (codes truncated for privacy).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-1 h-3 w-3", loading && "animate-spin")} /> Refresh
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {VERDICT_OPTIONS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setVerdict(v)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs uppercase tracking-wider transition",
                verdict === v ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by register UUID (optional)"
          value={registerFilter}
          onChange={(e) => setRegisterFilter(e.target.value.trim())}
          className="h-7 w-72 rounded border border-border bg-background px-2 text-xs"
        />
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Received</th>
              <th className="px-3 py-2 text-left font-medium">Register</th>
              <th className="px-3 py-2 text-left font-medium">Source</th>
              <th className="px-3 py-2 text-left font-medium">Code</th>
              <th className="px-3 py-2 text-left font-medium">Verdict</th>
              <th className="px-3 py-2 text-left font-medium">Workflow</th>
              <th className="px-3 py-2 text-right font-medium">Latency</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  No scan events match these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-3 py-1.5 tabular-nums">{new Date(r.received_at).toLocaleString()}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                  {r.register_id ? r.register_id.slice(0, 8) + "…" : "—"}
                </td>
                <td className="px-3 py-1.5">{r.source ?? "—"}</td>
                <td className="px-3 py-1.5 font-mono">{r.code_masked ?? "—"}</td>
                <td className="px-3 py-1.5">
                  <Badge variant="outline" className={cn("text-[10px]", verdictStyle(r.verdict))}>
                    {r.verdict ?? "—"}
                  </Badge>
                </td>
                <td className="px-3 py-1.5">{r.workflow ?? "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.latency_ms == null ? "—" : `${r.latency_ms}ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
