/**
 * DevicePresenceList — wave-5 multi-phone presence row.
 *
 * Renders one row per paired device with:
 *  - device label (from scanner_device_labels if renamed, else device_label
 *    from presence payload)
 *  - "Active" pill on the device whose last scan most recently advanced
 *    `lastScanByDevice[deviceId]` (30 s TTL)
 *  - inline rename input persisted via `pos_rename_scanner_device` RPC
 *  - "Suggest" chip that proposes 3 deterministic labels assembled from
 *    register name + device label + most-frequent recent workflow.
 *
 * Pure presentation + a couple of RPC calls. The presence payload itself
 * is owned by `usePOSScannerChannel` / `useScanChannel`; we just render it.
 */

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Pencil, Sparkles, Smartphone, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface PresenceDevice {
  user_id: string;
  device_label: string;
  online_at: string;
}

interface Props {
  sessionId: string;
  registerName?: string | null;
  devices: PresenceDevice[];
  /** Map of `device_id → last scan timestamp` from the realtime hook. */
  lastScanByDevice?: Record<string, number>;
}

interface LabelRow {
  device_id: string;
  label: string;
}

const ACTIVE_TTL_MS = 30_000;

/**
 * Deterministic fallback used when the AI gateway is unreachable or
 * returns nothing usable. Also rendered instantly so the chip never
 * appears empty before the AI response lands.
 */
function suggestLabels(args: {
  registerName?: string | null;
  deviceLabel: string;
  topWorkflow: string | null;
}): string[] {
  const reg = (args.registerName || "Register").trim();
  const dev = (args.deviceLabel || "Phone").trim();
  const wf = args.topWorkflow ? args.topWorkflow.replace(/(^|\s)\S/g, (s) => s.toUpperCase()) : null;
  const out = new Set<string>();
  if (wf) out.add(`${wf} · ${dev}`);
  out.add(`${reg} · ${dev}`);
  if (wf) out.add(`${reg} ${wf}`);
  out.add(dev);
  return Array.from(out).slice(0, 3).map((s) => s.slice(0, 28));
}

export function DevicePresenceList({ sessionId, registerName, devices, lastScanByDevice }: Props) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topWorkflow, setTopWorkflow] = useState<string | null>(null);
  const [suggestionsFor, setSuggestionsFor] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string[]>>({});
  const [aiLoadingFor, setAiLoadingFor] = useState<string | null>(null);

  // Load existing labels for this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("scanner_device_labels" as any)
        .select("device_id,label")
        .eq("session_id", sessionId);
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const r of ((data as unknown as LabelRow[]) ?? [])) next[r.device_id] = r.label;
      setLabels(next);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  // Best-effort: derive most-frequent recent workflow for suggestions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("list_scan_events" as any, {
        p_limit: 100,
        p_register: sessionId,
        p_verdict: null,
      } as any);
      if (cancelled || !Array.isArray(data)) return;
      const counts = new Map<string, number>();
      for (const row of data as Array<{ workflow: string | null }>) {
        const w = (row?.workflow ?? "").trim();
        if (!w) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      let top: string | null = null;
      let max = 0;
      for (const [w, c] of counts) {
        if (c > max) { top = w; max = c; }
      }
      setTopWorkflow(top);
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const now = Date.now();
  const activeDeviceId = useMemo(() => {
    if (!lastScanByDevice) return null;
    let bestId: string | null = null;
    let bestAt = 0;
    for (const [id, at] of Object.entries(lastScanByDevice)) {
      if (at > bestAt && now - at <= ACTIVE_TTL_MS) {
        bestAt = at;
        bestId = id;
      }
    }
    return bestId;
  }, [lastScanByDevice, now]);

  const handleSave = async (deviceId: string) => {
    const v = draft.trim();
    if (!v) { setEditing(null); return; }
    setSaving(true); setError(null);
    const { data, error } = await supabase.rpc("pos_rename_scanner_device" as any, {
      p_session: sessionId, p_device_id: deviceId, p_label: v,
    } as any);
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    const newLabel = (data as { label?: string } | null)?.label ?? v;
    setLabels((prev) => ({ ...prev, [deviceId]: newLabel }));
    setEditing(null);
  };

  /**
   * Toggle the suggestion chip. When opening it for a device, fire the
   * `suggest-scanner-label` edge function in the background. Until the
   * AI response arrives (or instead of it, on error/credits/etc.) the
   * deterministic `suggestLabels` fallback is shown so the chip is
   * always populated and never blocks the rename.
   */
  const handleToggleSuggestions = async (deviceId: string, deviceLabel: string) => {
    const next = suggestionsFor === deviceId ? null : deviceId;
    setSuggestionsFor(next);
    if (next !== deviceId) return;
    if (aiSuggestions[deviceId] || aiLoadingFor === deviceId) return;
    setAiLoadingFor(deviceId);
    try {
      const { data } = await supabase.functions.invoke("suggest-scanner-label", {
        body: {
          register_name: registerName ?? null,
          device_label: deviceLabel,
          top_workflow: topWorkflow,
        },
      });
      const arr = Array.isArray((data as any)?.suggestions)
        ? ((data as any).suggestions as string[]).filter((s) => typeof s === "string" && s.trim().length > 0)
        : [];
      if (arr.length > 0) setAiSuggestions((prev) => ({ ...prev, [deviceId]: arr.slice(0, 3) }));
    } catch {
      // Silent — deterministic fallback already rendered.
    } finally {
      setAiLoadingFor((cur) => (cur === deviceId ? null : cur));
    }
  };

  if (devices.length === 0) return null;

  return (
    <div className="space-y-2">
      {devices.map((d) => {
        const persisted = labels[d.user_id];
        const display = persisted || d.device_label || "Mobile device";
        const isActive = activeDeviceId === d.user_id;
        const isEditing = editing === d.user_id;
        const showSuggestions = suggestionsFor === d.user_id;
        const fallback = suggestLabels({
          registerName,
          deviceLabel: d.device_label,
          topWorkflow,
        });
        const ai = aiSuggestions[d.user_id];
        const candidates = (ai && ai.length > 0 ? ai : fallback).slice(0, 3);
        const isAiLoading = aiLoadingFor === d.user_id;

        return (
          <div
            key={d.user_id}
            className={cn(
              "rounded-md border p-2.5 text-sm transition",
              isActive ? "border-emerald-500/60 bg-emerald-500/5 ring-1 ring-emerald-500/30" : "border-border",
            )}
          >
            <div className="flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" />
              {isEditing ? (
                <div className="flex flex-1 items-center gap-1">
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value.slice(0, 64))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSave(d.user_id);
                      if (e.key === "Escape") { setEditing(null); setError(null); }
                    }}
                    className="h-7 text-xs"
                    placeholder="Scanner label"
                  />
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void handleSave(d.user_id)} disabled={saving}>
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setEditing(null); setError(null); }}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <>
                  <span className="flex-1 truncate font-medium">{display}</span>
                  {isActive && (
                    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 text-[10px]">
                      Active
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => { setDraft(persisted ?? d.device_label ?? ""); setEditing(d.user_id); setSuggestionsFor(null); }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Rename scanner"
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
            {isEditing && (
              <>
                <button
                  type="button"
                  onClick={() => void handleToggleSuggestions(d.user_id, d.device_label)}
                  className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted"
                >
                  {isAiLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Suggest
                </button>
                {showSuggestions && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {candidates.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setDraft(c)}
                        className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] hover:bg-muted"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                )}
                {error && <div className="mt-1 text-[11px] text-destructive">{error}</div>}
              </>
            )}
            <div className="mt-1 text-[10px] text-muted-foreground">
              online {new Date(d.online_at).toLocaleTimeString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
