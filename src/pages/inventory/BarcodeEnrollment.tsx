/**
 * Barcode Enrollment Workspace — scanner-first bulk barcode assignment.
 *
 * See ADR 0013 and `.lovable/plan.md` ("Inventory Scanner-First Barcode
 * Enrollment").
 *
 * Architecture invariants this file MUST preserve:
 *   - One top-priority `useScanTarget` registration owned by THIS page
 *     drives the workflow. Do NOT import `scanBus` directly here.
 *   - Persistence flows through `enroll_product_barcode` (atomic + RLS).
 *   - Audio/visual feedback flows through `scanFeedbackBus` + `usePOSSound`
 *     (reused, not duplicated). Per-user mute respected via `silent` flag.
 *   - Keyboard-only operation: every action is reachable without a mouse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Flag,
  ScanLine,
  SkipForward,
  Undo2,
  Volume2,
  VolumeX,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useScanTarget } from "@/hooks/pos/useScanTarget";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { ScannerPairingButton } from "@/components/scanner/ScannerPairingButton";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";
import { useProductsAwaitingBarcode } from "@/hooks/inventory/useProductsAwaitingBarcode";
import { useEnrollmentWorkflow } from "@/hooks/inventory/useEnrollmentWorkflow";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";

export default function BarcodeEnrollment() {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const businessId = currentBusiness?.id ?? null;
  const queryClient = useQueryClient();
  const { enabled: soundsEnabled, toggle: toggleSounds } = usePOSSound();
  const { isPaired } = useWorkspaceScanner();

  const [search, setSearch] = useState("");
  const [manualCode, setManualCode] = useState("");
  const manualInputRef = useRef<HTMLInputElement | null>(null);

  // Group C #3 — every routed scan on this screen is audited to
  // `scan_events` via the `workspace_id` lane.
  useActiveScanContext({ workspace_id: "enrollment" });

  const { data: products = [], isLoading } = useProductsAwaitingBarcode({
    businessId,
    search,
  });

  const wf = useEnrollmentWorkflow({
    businessId,
    products,
    silent: !soundsEnabled,
  });

  // After every successful enrollment, invalidate the queue so the next
  // realtime tick can't bring the same row back from a stale cache.
  useEffect(() => {
    if (wf.lastEnrolled) {
      queryClient.invalidateQueries({ queryKey: ["products-awaiting-barcode"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    }
  }, [wf.lastEnrolled, queryClient]);

  // After an UNDO (`lastEnrolled` flips back to null while doneCount drops)
  // refetch so the restored product reappears authoritatively from the DB
  // and any other consumer of `["products"]` stays consistent.
  const doneCount = wf.doneCount;
  const prevDoneRef = useRef(doneCount);
  useEffect(() => {
    if (doneCount < prevDoneRef.current) {
      queryClient.invalidateQueries({ queryKey: ["products-awaiting-barcode"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    }
    prevDoneRef.current = doneCount;
  }, [doneCount, queryClient]);



  // Single top-priority scan target. Priority 20 wins even when a stray
  // input on the page is focused — the workflow owns scans on this screen.
  // `active` is also gated by `validating` so a stray double-scan from a
  // flaky wedge doesn't fire a no-op dispatch.
  useScanTarget({
    active: !!wf.current && wf.status !== "validating",
    priority: 20,
    label: "BarcodeEnrollment",
    workflow: "identity",
    onScan: (e) => {
      void wf.submit(e.code);
    },
  });

  const handleManualSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const code = manualCode.trim();
      if (!code) return;
      void wf.submit(code);
      setManualCode("");
    },
    [manualCode, wf],
  );

  // Keyboard shortcuts — scoped to the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in any input (manual code, search, etc.)
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea";
      if (isTyping) {
        if (e.key === "Escape") {
          (e.target as HTMLElement).blur();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        wf.skip();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        void wf.undo();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        void wf.flag("Flagged in enrollment workspace");
      } else if (e.key === "/") {
        e.preventDefault();
        manualInputRef.current?.focus();
      } else if (e.key === "]") {
        e.preventDefault();
        wf.jump(1);
      } else if (e.key === "[") {
        e.preventDefault();
        wf.jump(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wf]);

  const total = products.length;
  const position = useMemo(() => {
    if (!wf.current || total === 0) return 0;
    return total - wf.queue.length + 1;
  }, [wf.current, wf.queue.length, total]);

  if (!businessId) {
    return (
      <div className="p-6 text-muted-foreground">
        Select a business to enroll barcodes.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-[600px] bg-background">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center gap-4 flex-wrap">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/inventory-app/products" className="gap-1">
            <ArrowLeft className="h-4 w-4" /> Products
          </Link>
        </Button>
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold leading-tight">Barcode Enrollment</h1>
          <p className="text-xs text-muted-foreground">
            {isLoading
              ? "Loading queue…"
              : total === 0
                ? "All products have barcodes. Nothing to enroll."
                : `${total} product${total === 1 ? "" : "s"} awaiting barcode${
                    currentBranch ? ` · ${currentBranch.name}` : ""
                  }`}
          </p>
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter queue (name or SKU)…"
          className="max-w-xs h-8"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleSounds}
          title={soundsEnabled ? "Mute scanner sounds" : "Unmute scanner sounds"}
        >
          {soundsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </Button>
        <ScannerPairingButton businessId={businessId} label="Barcode Enrollment" />
        <Badge variant={isPaired ? "default" : "outline"} className="text-[10px]">
          {isPaired ? "Phone paired" : "Keyboard / wedge"}
        </Badge>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[280px_1fr] overflow-hidden">
        {/* Queue sidebar */}
        <aside className="border-r overflow-y-auto bg-muted/30">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Queue ({wf.queue.length})
          </div>
          <ul className="divide-y">
            {wf.queue.slice(0, 50).map((p, idx) => (
              <li
                key={p.id}
                className={cn(
                  "px-3 py-2 text-sm",
                  idx === 0 && "bg-primary/5 border-l-2 border-l-primary font-medium",
                )}
              >
                <div className="truncate">{p.name}</div>
                {p.sku && (
                  <div className="text-[11px] text-muted-foreground truncate">
                    {p.sku}
                  </div>
                )}
              </li>
            ))}
            {wf.queue.length > 50 && (
              <li className="px-3 py-2 text-[11px] text-muted-foreground">
                +{wf.queue.length - 50} more…
              </li>
            )}
            {wf.queue.length === 0 && !isLoading && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-emerald-500" />
                Queue empty.
              </li>
            )}
          </ul>
          <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            Enrolled this session: <span className="font-medium text-foreground">{wf.doneCount}</span>
          </div>
        </aside>

        {/* Main panel */}
        <main className="overflow-y-auto p-6 flex flex-col gap-5">
          {wf.current ? (
            <>
              <div className="text-xs text-muted-foreground">
                Now enrolling — {position} of {total}
              </div>

              <Card
                className={cn(
                  "transition-colors",
                  wf.status === "duplicate" && "border-amber-500/60",
                  wf.status === "invalid" && "border-destructive/60",
                  wf.status === "ready" && wf.lastEnrolled && "border-emerald-500/30",
                )}
              >
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center gap-4">
                    {wf.current.image_url ? (
                      <img
                        src={wf.current.image_url}
                        alt=""
                        className="h-14 w-14 rounded object-cover border"
                      />
                    ) : (
                      <div className="h-14 w-14 rounded bg-muted grid place-items-center text-muted-foreground text-xs">
                        no img
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div
                        className="text-base font-semibold truncate"
                        data-testid="enroll-current-name"
                      >
                        {wf.current.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {wf.current.sku ?? "—"} · {wf.current.unit_price?.toLocaleString?.() ?? wf.current.unit_price}
                      </div>
                    </div>
                  </div>

                  <Separator />

                  <form onSubmit={handleManualSubmit} className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <ScanLine className="h-3.5 w-3.5" />
                      Scan barcode now
                    </label>
                    <div className="flex gap-2">
                      <Input
                        ref={manualInputRef}
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        placeholder="Waiting for scan… or type a code and press Enter"
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        data-testid="enroll-manual-input"
                        className={cn(
                          "h-11 text-base font-mono",
                          wf.status === "duplicate" && "border-amber-500 focus-visible:ring-amber-500",
                          wf.status === "invalid" && "border-destructive focus-visible:ring-destructive",
                        )}
                        disabled={wf.status === "validating"}
                      />
                      <Button type="submit" disabled={!manualCode.trim() || wf.status === "validating"}>
                        {wf.status === "validating" ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          "Assign"
                        )}
                      </Button>
                    </div>
                    {wf.lastError && (
                      <div
                        data-testid="enroll-feedback"
                        className={cn(
                          "text-xs flex items-center gap-1.5 pt-1",
                          wf.lastError.kind === "duplicate" ? "text-amber-600" : "text-destructive",
                        )}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {wf.lastError.message}
                      </div>
                    )}
                  </form>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={wf.skip} className="gap-1.5" data-testid="enroll-skip">
                      <SkipForward className="h-3.5 w-3.5" /> Skip
                      <kbd className="ml-1 text-[10px] text-muted-foreground">Esc</kbd>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void wf.flag("Flagged in enrollment workspace")}
                      className="gap-1.5"
                      data-testid="enroll-flag"
                    >
                      <Flag className="h-3.5 w-3.5" /> Flag for review
                      <kbd className="ml-1 text-[10px] text-muted-foreground">F</kbd>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void wf.undo()}
                      disabled={!wf.lastEnrolled}
                      className="gap-1.5"
                      data-testid="enroll-undo"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Undo last
                      <kbd className="ml-1 text-[10px] text-muted-foreground">⌃Z</kbd>
                    </Button>
                    <div className="flex gap-1 ml-auto">
                      <Button variant="ghost" size="sm" onClick={() => wf.jump(-1)} title="Previous ([)">
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => wf.jump(1)} title="Next (])">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {wf.lastEnrolled && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  Last: <span className="text-foreground">{wf.lastEnrolled.productName}</span>{" "}
                  ← <span className="font-mono">{wf.lastEnrolled.code}</span>
                </div>
              )}

              <div className="mt-auto text-[11px] text-muted-foreground border-t pt-3">
                Shortcuts: scan or type + Enter to assign · <kbd>Esc</kbd> skip ·{" "}
                <kbd>F</kbd> flag · <kbd>Ctrl+Z</kbd> undo · <kbd>/</kbd> focus field ·{" "}
                <kbd>[</kbd>/<kbd>]</kbd> previous / next
              </div>
            </>
          ) : (
            <div className="flex-1 grid place-items-center text-center">
              <div className="max-w-sm space-y-3">
                <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
                <h2 className="text-lg font-semibold">
                  {isLoading ? "Loading…" : "Queue cleared"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {isLoading
                    ? "Looking for products that need barcodes."
                    : "Every product in this business has an assigned barcode."}
                </p>
                {wf.doneCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    You enrolled {wf.doneCount} product{wf.doneCount === 1 ? "" : "s"} this session.
                  </p>
                )}
                <Button variant="outline" asChild>
                  <Link to="/inventory-app/products">Back to Products</Link>
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
