/**
 * ScannerSettings — /settings/scanner
 *
 * Tenant + per-user policy for how phone-as-scanner scans are routed
 * across modules. See `useScannerScopePolicy` for the semantics:
 *
 *   - Ambient (default): any focused barcode field across the app
 *     receives scans from any paired phone. Behaves like a real
 *     handheld scanner — pair once, works everywhere.
 *
 *   - Scoped: a POS-paired phone feeds ONLY the POS cart; a
 *     workspace-paired phone feeds ONLY Inventory / Sales /
 *     Products / etc. Recommended when a cashier and a stock clerk
 *     share the same workstation.
 *
 * Keyboard wedge scanners and manual entry are NEVER filtered — they
 * always reach the focused field in either mode.
 */

import { PlatformAppLayout } from "@/apps/platform";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ScanLine } from "lucide-react";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";
import { useIsLikelyMobile } from "@/hooks/useIsLikelyMobile";
import { Smartphone, Camera } from "lucide-react";
import { useState } from "react";
import { InAppQrScanner } from "@/components/scanner/InAppQrScanner";
import {
  useScannerScopePolicy,
  type ScannerScopeMode,
} from "@/hooks/scanner/useScannerScopePolicy";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

const MODE_OPTIONS: { value: ScannerScopeMode; label: string; description: string }[] = [
  {
    value: "ambient",
    label: "Ambient (default)",
    description:
      "Any paired phone can scan into any focused barcode field, anywhere in the app. Like a real handheld scanner — pair once, works everywhere.",
  },
  {
    value: "scoped",
    label: "Scoped",
    description:
      "POS-paired phones feed only the POS cart. Workspace-paired phones feed only Inventory, Sales, Products, and other non-POS forms. Use this when a cashier and a stock clerk share a workstation.",
  },
];

export default function ScannerSettings() {
  const { currentBusiness } = useBusinesses();
  const permissions = usePermissions();
  const isMobile = useIsLikelyMobile();
  const { openPairing } = useWorkspaceScanner();
  const [qrOpen, setQrOpen] = useState(false);
  const isAdmin = Boolean(
    (permissions as { isAdmin?: boolean; isOwner?: boolean })?.isAdmin ||
      (permissions as { isAdmin?: boolean; isOwner?: boolean })?.isOwner,
  );

  const {
    mode,
    tenantMode,
    userMode,
    isLoading,
    setTenantMode,
    setUserMode,
    clearUserMode,
  } = useScannerScopePolicy(currentBusiness?.id ?? null);

  const handleTenantChange = async (next: string) => {
    try {
      await setTenantMode(next as ScannerScopeMode);
      toast.success(`Default scanner mode set to "${next}".`);
    } catch (err) {
      toast.error(normalizeError(err).message);
    }
  };

  const handleUserChange = async (next: string) => {
    try {
      await setUserMode(next as ScannerScopeMode);
      toast.success(`Your scanner mode override is set to "${next}".`);
    } catch (err) {
      toast.error(normalizeError(err).message);
    }
  };

  const handleClearOverride = async () => {
    try {
      await clearUserMode();
      toast.success("Following the workspace default again.");
    } catch (err) {
      toast.error(normalizeError(err).message);
    }
  };

  return (
    <PlatformAppLayout>
      <div className="container mx-auto py-8 space-y-6 max-w-3xl">
        <div className="flex items-center gap-3">
          <ScanLine className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Scanner</h1>
            <p className="text-sm text-muted-foreground">
              Control how scans from paired phones are routed across modules.
            </p>
          </div>
        </div>

        {isMobile && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="h-4 w-4" /> Pair this phone
              </CardTitle>
              <CardDescription>
                Shortcuts so you don't have to leave the app to scan a QR code.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              <Button onClick={() => openPairing("This phone")}>
                <Smartphone className="mr-2 h-4 w-4" /> Pair this device
              </Button>
              <Button variant="outline" onClick={() => setQrOpen(true)}>
                <Camera className="mr-2 h-4 w-4" /> Scan QR with phone
              </Button>
            </CardContent>
          </Card>
        )}
        <InAppQrScanner open={qrOpen} onClose={() => setQrOpen(false)} />

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Workspace default</CardTitle>
                <CardDescription>
                  Applies to every user in this business unless they set a personal override below.
                </CardDescription>
              </div>
              <Badge variant="outline">{tenantMode ?? "ambient"}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading policy…
              </div>
            ) : (
              <RadioGroup
                value={tenantMode ?? "ambient"}
                onValueChange={handleTenantChange}
                disabled={!isAdmin}
              >
                <div className="space-y-3">
                  {MODE_OPTIONS.map((opt) => (
                    <div key={opt.value} className="flex items-start gap-3 rounded-md border p-3">
                      <RadioGroupItem value={opt.value} id={`tenant-${opt.value}`} className="mt-1" />
                      <Label htmlFor={`tenant-${opt.value}`} className="cursor-pointer space-y-1">
                        <div className="font-medium">{opt.label}</div>
                        <div className="text-xs text-muted-foreground">{opt.description}</div>
                      </Label>
                    </div>
                  ))}
                </div>
              </RadioGroup>
            )}
            {!isAdmin && !isLoading ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Only owners and admins can change the workspace default.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Personal override</CardTitle>
                <CardDescription>
                  Applies only to your sign-in on this device family. Other users keep the workspace default.
                </CardDescription>
              </div>
              <Badge variant={userMode ? "default" : "outline"}>{userMode ?? "following default"}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <RadioGroup
              value={userMode ?? ""}
              onValueChange={handleUserChange}
            >
              <div className="space-y-3">
                {MODE_OPTIONS.map((opt) => (
                  <div key={opt.value} className="flex items-start gap-3 rounded-md border p-3">
                    <RadioGroupItem value={opt.value} id={`user-${opt.value}`} className="mt-1" />
                    <Label htmlFor={`user-${opt.value}`} className="cursor-pointer space-y-1">
                      <div className="font-medium">{opt.label}</div>
                      <div className="text-xs text-muted-foreground">{opt.description}</div>
                    </Label>
                  </div>
                ))}
              </div>
            </RadioGroup>
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                Effective mode: <span className="font-medium">{mode}</span>
              </p>
              {userMode ? (
                <Button variant="outline" size="sm" onClick={handleClearOverride}>
                  Clear override
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-muted/30">
          <CardHeader>
            <CardTitle className="text-base">How this works</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>
              A phone, when paired, binds to <span className="font-mono">one</span> realtime topic — either a POS register
              (<span className="font-mono">pos:scan:&lt;register&gt;</span>) or a workspace session
              (<span className="font-mono">scan:session:&lt;uuid&gt;</span>).
            </p>
            <p>
              In <strong>Ambient</strong>, scans from either topic land in any focused barcode field.
            </p>
            <p>
              In <strong>Scoped</strong>, POS-register scans go only to the POS cart, and workspace-session scans go only
              to non-POS forms. Scans that arrive when their target module isn't open are silently dropped.
            </p>
            <p>
              Keyboard-wedge scanners and manual entry are never filtered — they always reach the focused field.
            </p>
          </CardContent>
        </Card>
      </div>
    </PlatformAppLayout>
  );
}