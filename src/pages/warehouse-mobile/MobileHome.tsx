/**
 * Mobile home — operator's assigned tasks grouped by type.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { PackageCheck, PackagePlus, ClipboardCheck, Truck, Package, ShieldCheck, Boxes } from "lucide-react";

interface Row {
  id: string;
  task_type: string;
  state: string;
  metadata: Record<string, unknown> | null;
}

const TILES = [
  { key: "putaway", to: (id: string) => `/wm/putaway/${id}`, label: "Put-away", icon: PackagePlus },
  { key: "pick", to: (id: string) => `/wm/pick/${id}`, label: "Pick", icon: PackageCheck },
  { key: "pack", to: (id: string) => `/wm/pack/${id}`, label: "Pack", icon: Package },
] as const;

export default function MobileHome() {
  const { data: tasks } = useQuery({
    queryKey: ["wm-my-tasks"],
    queryFn: async () => {
      const uid = (await supabase.auth.getUser()).data.user?.id;
      if (!uid) return [];
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, task_type, state, metadata")
        .eq("assignee_user_id", uid)
        .in("state", ["pending", "assigned", "in_progress"])
        .order("priority", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
    refetchInterval: 15000,
  });

  const { data: sessions } = useQuery({
    queryKey: ["wm-count-sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_count_sessions")
        .select("id, code, state")
        .in("state", ["draft", "counting", "review"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as { id: string; code: string; state: string }[];
    },
  });

  const { data: receipts } = useQuery({
    queryKey: ["wm-open-receipts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id, receipt_number, status")
        .in("status", ["draft", "received"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: manifests } = useQuery({
    queryKey: ["wm-open-manifests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_loading_manifests")
        .select("id, code, state")
        .in("state", ["loading", "closed"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as { id: string; code: string; state: string }[];
    },
  });

  const { data: qcOpen } = useQuery({
    queryKey: ["wm-open-qc"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_qc_inspections")
        .select("id, state, product:product_id(sku)")
        .in("state", ["pending", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        state: string;
        product: { sku: string | null } | null;
      }[];
    },
  });

  const byType = new Map<string, Row[]>();
  for (const t of tasks ?? []) {
    const arr = byType.get(t.task_type) ?? [];
    arr.push(t);
    byType.set(t.task_type, arr);
  }

  return (
    <MobileWarehouseLayout title="My tasks">
      <div className="space-y-4">
        <Link
          to="/wm/plate"
          className="flex items-center justify-between rounded border p-3 active:bg-muted"
        >
          <div className="flex items-center gap-3">
            <Boxes className="h-5 w-5 text-primary" />
            <div>
              <div className="text-sm font-medium">License plate</div>
              <div className="text-xs text-muted-foreground">Scan a plate to view or move it</div>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">tap →</span>
        </Link>

        {TILES.map(({ key, to, label, icon: Icon }) => {
          const rows = byType.get(key) ?? [];
          return (
            <section key={key}>
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                {label} <span className="text-xs">· {rows.length}</span>
              </h2>
              {rows.length === 0 ? (
                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                  Nothing assigned.
                </div>
              ) : (
                <ul className="space-y-2">
                  {rows.map((t) => (
                    <li key={t.id}>
                      <Link
                        to={to(t.id)}
                        className="flex items-center justify-between rounded border p-3 active:bg-muted"
                      >
                        <div className="flex items-center gap-3">
                          <Icon className="h-5 w-5 text-primary" />
                          <div>
                            <div className="font-mono text-sm">{t.id.slice(0, 8)}</div>
                            <div className="text-xs text-muted-foreground">{t.state}</div>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">tap →</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            <Truck className="inline h-4 w-4 mr-1" />Receiving
          </h2>
          {(receipts ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No open goods receipts.
            </div>
          ) : (
            <ul className="space-y-2">
              {receipts!.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/wm/receive/${r.id}`}
                    className="flex items-center justify-between rounded border p-3 active:bg-muted"
                  >
                    <div>
                      <div className="font-mono text-sm">{r.receipt_number}</div>
                      <div className="text-xs text-muted-foreground">{r.status}</div>
                    </div>
                    <span className="text-xs text-muted-foreground">tap →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            <ClipboardCheck className="inline h-4 w-4 mr-1" />Cycle counts
          </h2>
          {(sessions ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No open sessions.
            </div>
          ) : (
            <ul className="space-y-2">
              {sessions!.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/wm/count/${s.id}`}
                    className="flex items-center justify-between rounded border p-3 active:bg-muted"
                  >
                    <div>
                      <div className="font-mono text-sm">{s.code}</div>
                      <div className="text-xs text-muted-foreground">{s.state}</div>
                    </div>
                    <span className="text-xs text-muted-foreground">tap →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            <Truck className="inline h-4 w-4 mr-1" />Dispatch
          </h2>
          {(manifests ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No open manifests.
            </div>
          ) : (
            <ul className="space-y-2">
              {manifests!.map((m) => (
                <li key={m.id}>
                  <Link
                    to={`/wm/dispatch/${m.id}`}
                    className="flex items-center justify-between rounded border p-3 active:bg-muted"
                  >
                    <div>
                      <div className="font-mono text-sm">{m.code}</div>
                      <div className="text-xs text-muted-foreground">{m.state}</div>
                    </div>
                    <span className="text-xs text-muted-foreground">tap →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            <ShieldCheck className="inline h-4 w-4 mr-1" />Quality control
          </h2>
          {(qcOpen ?? []).length === 0 ? (
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              No open inspections.
            </div>
          ) : (
            <ul className="space-y-2">
              {qcOpen!.map((q) => (
                <li key={q.id}>
                  <Link
                    to={`/wm/qc/${q.id}`}
                    className="flex items-center justify-between rounded border p-3 active:bg-muted"
                  >
                    <div>
                      <div className="font-mono text-sm">{q.product?.sku ?? q.id.slice(0, 8)}</div>
                      <div className="text-xs text-muted-foreground">{q.state}</div>
                    </div>
                    <span className="text-xs text-muted-foreground">tap →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MobileWarehouseLayout>
  );
}
