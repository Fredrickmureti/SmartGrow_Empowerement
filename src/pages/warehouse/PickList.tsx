/**
 * PickList — scan-first operator screen for a single pick wave.
 *
 * Phase 4a — Scanner-driven directed picking.
 *
 * The operator scans a **bin** and a **product**; the screen resolves
 * both against the wave's open pick tasks and highlights the single
 * matching row. Confirm fires the sanctioned `complete_pick_task(...)`
 * RPC — the only path that decrements quants and rolls up the wave.
 *
 * Wrong-bin or wrong-product scans surface an inline warning and are
 * refused (the Confirm button on non-matching rows stays live for
 * supervisor override, but the highlighted "scan target" is always the
 * matching task).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWarehouseQtyFormatter, WarehouseQty } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";

import { Link, useParams } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCompletePickTask } from "@/features/warehouse/aggregates/useDomainOperations";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
  StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Check, PackageCheck, ScanLine, X, MapPin, Package } from "lucide-react";
import { BarcodeInputField } from "@/components/scanner/BarcodeInputField";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useResolveProductIdentity } from "@/hooks/inventory/useResolveProductIdentity";
import { identityOutcomeLine } from "@/features/products/identity/identityOutcome";
import { cn } from "@/lib/utils";

interface PickTask {
  id: string;
  state: "pending" | "available" | "claimed" | "in_progress" | "paused" | "resumed" | "completed" | "cancelled" | "exception";
  quantity: number | null;
  product_id: string | null;
  lot_number: string | null;
  source_location_id: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  product: { name: string; sku: string | null } | null;
  source_loc: { code: string; name: string } | null;
}

const STATE_TONE = {
  pending: "neutral",
  assigned: "info",
  in_progress: "warning",
  done: "success",
  cancelled: "danger",
} as const;

export default function PickList() {
  const { waveId } = useParams<{ waveId: string }>();
  const complete = useCompletePickTask(waveId);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  // Phase C3 — picking resolves identity through the canonical resolver so a
  // case/inner barcode identifies the same product as its each-level code.
  const { resolve: resolveIdentity } = useResolveProductIdentity(
    currentBusiness?.id,
    currentBranch?.id ?? null,
  );

  const [pickedQty, setPickedQty] = useState<Record<string, string>>({});

  // Scan state.
  const [binCode, setBinCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [scanProductId, setScanProductId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const productRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const { data: wave } = useQuery({
    queryKey: ["wms-pick-wave", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_pick_waves")
        .select("id, wave_number, state, warehouse_id, created_at, released_at")
        .eq("id", waveId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: tasks, isLoading } = useQuery({
    queryKey: ["wms-pick-tasks", waveId],
    enabled: !!waveId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_tasks")
        .select("id, state, quantity, product_id, lot_number, source_location_id, notes, metadata, product:product_id(name, sku), source_loc:source_location_id(code, name)")
        .eq("task_type", "pick")
        .contains("metadata", { wave_id: waveId })
        .order("state")
        .order("priority", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as PickTask[];
    },
  });

  const onPickSuccess = () => {
    toast.success("Pick confirmed");
    setBinCode("");
    setProductCode("");
    setScanProductId(null);
    setScanError(null);
  };

  const open = useMemo(
    () => (tasks ?? []).filter((t) => t.state !== "completed" && t.state !== "cancelled"),
    [tasks],
  );
  const done = useMemo(() => (tasks ?? []).filter((t) => t.state === "completed"), [tasks]);

  // Phase 2.4 — unit truth: pack rollup + the product's own base UoM label.
  const taskProductIds = useMemo(() => (tasks ?? []).map((t) => t.product_id), [tasks]);
  const qtyBaseLabels = useProductBaseUomLabels(taskProductIds);
  const qtyFmt = useWarehouseQtyFormatter(taskProductIds, qtyBaseLabels);


  // Resolve the currently scanned bin+product to the single matching task.
  // A match requires: bin code equals task.source_loc.code (case-insensitive)
  // AND scanned product resolves to task.product_id.
  const matched = useMemo(() => {
    const bin = binCode.trim().toLowerCase();
    if (!bin || !scanProductId) return null;
    return open.find(
      (t) =>
        (t.source_loc?.code ?? "").toLowerCase() === bin &&
        t.product_id === scanProductId,
    ) ?? null;
  }, [binCode, scanProductId, open]);

  // Recompute scan diagnostics whenever inputs change.
  useEffect(() => {
    if (!binCode.trim() && !scanProductId) {
      setScanError(null);
      return;
    }
    if (binCode.trim() && !open.some((t) => (t.source_loc?.code ?? "").toLowerCase() === binCode.trim().toLowerCase())) {
      setScanError(`No open pick at bin ${binCode.trim()}.`);
      return;
    }
    if (scanProductId && !open.some((t) => t.product_id === scanProductId)) {
      setScanError("Scanned product is not on this wave.");
      return;
    }
    if (binCode.trim() && scanProductId && !matched) {
      setScanError("Wrong bin for this product.");
      return;
    }
    setScanError(null);
  }, [binCode, scanProductId, open, matched]);

  // Scroll match into view + prefill qty.
  useEffect(() => {
    if (!matched) return;
    rowRefs.current[matched.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setPickedQty((p) =>
      p[matched.id] != null ? p : { ...p, [matched.id]: String(matched.quantity ?? "") },
    );
  }, [matched]);

  const handleProductScan = useCallback(
    async (code: string) => {
      if (!code.trim()) {
        setScanProductId(null);
        return;
      }
      const result = await resolveIdentity(code);
      if (result.kind === "resolved") {
        setScanProductId(result.identity.productId);
        return;
      }
      // Never guess: every non-resolved outcome blocks the pick and states
      // its own reason (duplicate, retired, expired, unknown, offline).
      setScanProductId(null);
      setScanError(
        identityOutcomeLine({
          status: result.kind,
          code,
          matchCount: result.kind === "ambiguous" ? result.matchCount : undefined,
        }),
      );
    },
    [resolveIdentity],
  );

  return (
    <>
      <PageHeader
        title={<span className="font-mono">{wave?.wave_number ?? "Wave"}</span>}
        description={wave ? `State: ${wave.state}` : "Loading…"}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/waves"><ArrowLeft className="h-4 w-4 mr-2" /> Waves</Link>
            </Button>
            {wave?.state === "picked" && (
              <Button asChild>
                <Link to={`/warehouse-app/pack/${waveId}`}><PackageCheck className="h-4 w-4 mr-2" /> Pack</Link>
              </Button>
            )}
          </div>
        }
      />
      <PageBody>
        {/* Scan-first strip. Sticky so it stays visible on long wave lists. */}
        <Section
          title="Directed pick"
          description="Scan the bin, then scan the product. The matching task highlights and pre-fills."
          className={cn(matched && "border-emerald-500/40")}
        >
          <div className="space-y-3">
              <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2">
                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Bin
                  </Label>
                  <BarcodeInputField
                    value={binCode}
                    onChange={setBinCode}
                    workflow="identity"
                    fieldLabel="Bin"
                    placeholder="Scan or type bin"
                    nextFocusRef={productRef}
                  />
                </div>
                <div>
                  <Label className="text-xs flex items-center gap-1">
                    <Package className="h-3 w-3" /> Product
                  </Label>
                  <BarcodeInputField
                    ref={productRef as never}
                    value={productCode}
                    onChange={(v) => {
                      setProductCode(v);
                      if (!v.trim()) setScanProductId(null);
                    }}
                    onScan={handleProductScan}
                    workflow="identity"
                    fieldLabel="Product"
                    placeholder="Scan or type product"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 min-h-6">
                {scanError && (
                  <span className="text-xs inline-flex items-center gap-1 text-destructive">
                    <X className="h-3 w-3" /> {scanError}
                  </span>
                )}
                {matched && !scanError && (
                  <span className="text-xs inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" /> Match: {matched.product?.name} @ {matched.source_loc?.code}
                  </span>
                )}
                {!binCode && !productCode && !scanError && (
                  <span className="text-xs inline-flex items-center gap-1 text-muted-foreground">
                    <ScanLine className="h-3 w-3" /> Waiting for scan…
                  </span>
                )}
                {matched && (
                  <div className="ml-auto flex items-center gap-2">
                    <Input
                      className="w-24"
                      type="number"
                      min="0"
                      step="0.01"
                      value={pickedQty[matched.id] ?? String(matched.quantity ?? "")}
                      onChange={(e) => setPickedQty((p) => ({ ...p, [matched.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      disabled={complete.isPending}
                      onClick={() =>
                        complete.mutate(
                          {
                            taskId: matched.id,
                            pickedQty: Number(pickedQty[matched.id] ?? matched.quantity ?? 0),
                          },
                          { onSuccess: onPickSuccess },
                        )
                      }
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Confirm pick
                    </Button>
                  </div>
                )}
            </div>
          </div>
        </Section>

        <Section title="Open picks" description="Ordered by pick sequence. The scan strip highlights the current target." contentClassName="px-0 pb-0">
          {isLoading ? (
            <LoadingState />
          ) : open.length === 0 ? (
            <EmptyState
              icon={PackageCheck}
              title="All picks complete"
              description={wave?.state === "picked" ? "Move to packing." : "Nothing left to pick."}
            />
          ) : (
            <ul className="divide-y">
              {open.map((t) => {
                const suggested = t.quantity != null ? String(t.quantity) : "";
                const val = pickedQty[t.id] ?? suggested;
                const isMatch = matched?.id === t.id;
                return (
                  <li
                    key={t.id}
                    ref={(el) => { rowRefs.current[t.id] = el; }}
                    className={cn(
                      "p-3 flex flex-wrap items-center gap-3 transition-colors",
                      isMatch && "bg-emerald-500/5 ring-1 ring-inset ring-emerald-500/30",
                    )}
                  >
                    <StatusBadge tone={STATE_TONE[t.state]}>{t.state.replace("_", " ")}</StatusBadge>
                    <span className="font-mono text-sm">{t.source_loc?.code ?? "?"}</span>
                    <span className="text-sm flex-1">
                      {t.product?.name ?? "—"}
                      {t.product?.sku ? <span className="text-muted-foreground"> · {t.product.sku}</span> : null}
                      {t.lot_number ? <span className="text-muted-foreground"> · lot {t.lot_number}</span> : null}
                      {t.notes ? <span className="text-warning ml-2">· {t.notes}</span> : null}
                    </span>
                    <div className="text-xs text-muted-foreground">
                      req <WarehouseQty fmt={qtyFmt} productId={t.product_id} baseQty={t.quantity} />
                    </div>

                    <Input
                      className="w-24"
                      type="number"
                      min="0"
                      step="0.01"
                      value={val}
                      onChange={(e) => setPickedQty((p) => ({ ...p, [t.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      variant={isMatch ? "default" : "outline"}
                      disabled={complete.isPending}
                      onClick={() => complete.mutate({ taskId: t.id, pickedQty: Number(val || 0) }, { onSuccess: onPickSuccess })}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Confirm
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {done.length > 0 && (
          <Section title={`Completed (${done.length})`} contentClassName="px-0 pb-0">
            <ul className="divide-y">
              {done.map((t) => (
                <li key={t.id} className="p-3 flex items-center gap-3 text-sm">
                  <StatusBadge tone="success">done</StatusBadge>
                  <span className="font-mono">{t.source_loc?.code ?? "—"}</span>
                  <span className="flex-1">{t.product?.name ?? "—"}</span>
                  <span className="font-mono">
                    <WarehouseQty fmt={qtyFmt} productId={t.product_id} baseQty={t.quantity} />
                  </span>

                </li>
              ))}
            </ul>
          </Section>
        )}
        <ActivitySection aggregateId={waveId} title="Wave activity" description="Lifecycle events emitted for this pick wave." />
      </PageBody>
    </>
  );
}
