/**
 * SalesScanChip — small persistent indicator showing scan readiness for
 * the Sales workspace. Renders the current mode (Rapid / Browse), the
 * paired-phone status, and a one-click toggle. Visible only inside Sales
 * routes (mounted by SalesLayout).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Smartphone, Zap, Eye, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSalesScanMode } from "@/contexts/SalesScanContext";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";
import { useToast } from "@/hooks/use-toast";

const HINT_KEY = "sales.scan.rapid.hint.seen";

export function SalesScanChip() {
  const { mode, setMode, available } = useSalesScanMode();
  const scanner = useWorkspaceScanner();
  const { toast } = useToast();
  const [pulse, setPulse] = useState(false);
  const lastModeRef = useRef(mode);

  // Pulse the chip briefly when mode changes so the operator notices.
  useEffect(() => {
    if (lastModeRef.current === mode) return;
    lastModeRef.current = mode;
    setPulse(true);
    const t = window.setTimeout(() => setPulse(false), 800);
    return () => window.clearTimeout(t);
  }, [mode]);

  const onToggle = useCallback(() => {
    const next = mode === "rapid" ? "browse" : "rapid";
    setMode(next);
    if (next === "rapid") {
      let seen = false;
      try { seen = localStorage.getItem(HINT_KEY) === "1"; } catch { /* noop */ }
      if (!seen) {
        toast({
          title: "Rapid Scan enabled",
          description:
            "Scans will now open a new invoice draft automatically when none is open. Toggle off anytime from the chip.",
        });
        try { localStorage.setItem(HINT_KEY, "1"); } catch { /* noop */ }
      }
    }
  }, [mode, setMode, toast]);

  if (!available) return null;

  const isRapid = mode === "rapid";
  const paired = scanner.isPaired;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        data-testid="sales-scan-chip"
        className={cn(
          "inline-flex items-center gap-1 rounded-full border bg-card/80 backdrop-blur-sm px-2 py-1 text-xs shadow-sm transition-all",
          pulse && "ring-2 ring-primary",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggle}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors",
                isRapid
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80",
              )}
              aria-pressed={isRapid}
              aria-label={isRapid ? "Disable Rapid Scan" : "Enable Rapid Scan"}
            >
              {isRapid ? <Zap className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              <span>{isRapid ? "Rapid" : "Browse"}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isRapid
              ? "Scans auto-open an invoice draft when none is active. Click to switch to Browse."
              : "Scans only feed an open invoice dialog. Click to enable auto-open (Rapid)."}
          </TooltipContent>
        </Tooltip>

        <span className="h-3 w-px bg-border" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs"
              onClick={() => scanner.openPairing("Sales workspace")}
            >
              <Smartphone className="h-3 w-3" />
              {paired ? (
                <Wifi className="h-3 w-3 text-emerald-500" />
              ) : (
                <WifiOff className="h-3 w-3 text-muted-foreground" />
              )}
              <span className="sr-only">
                {paired ? "Phone paired" : "Pair phone"}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {paired ? "A phone is paired to this workspace." : "Pair a phone as scanner."}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
