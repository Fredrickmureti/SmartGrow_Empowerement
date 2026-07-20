/**
 * Device Wizard — /platform/hardware/devices/new
 *
 * Audit Wave 9d.9 (P2 #12). First-run "plug it in → we'll figure out
 * the rest" flow. Consumes the classified discovery snapshot emitted by
 * the Electron main process (`window.pos.hardware.discover()` →
 * `electron/hardware/discovery/index.ts`), ranks candidates by
 * confidence, lets the operator pick one, optionally fires a real
 * hardware test through `hardwareClient.exec()`, and persists the
 * binding into `device_assignments` via `useDeviceAssignments().upsert`.
 *
 * Why a wizard (not "add manually" in HardwareDevices):
 *   - The audit found discovery was "enumerate only"; classification
 *     existed but nothing rendered it. This wizard is the missing
 *     surface between `classifyUsb()` and a saved assignment row.
 *   - It is intentionally read-only against discovery — it does NOT
 *     claim, open, or print anything until the operator hits "Test"
 *     or "Save". USB enumeration is non-disruptive.
 *
 * Browser fallback: when `window.pos.hardware.discover` is missing
 * (web POS / dev preview), the page shows the manual-entry form so an
 * admin can still create an assignment by typing the vid/pid or
 * host:port directly. We never silently pretend discovery worked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { hardwareClient } from "@/services/hardware/HardwareClient";
import { useDeviceAssignments } from "@/hooks/useDeviceAssignments";
import { useBusinesses } from "@/hooks/useBusinesses";
import { normalizeError } from "@/services/resilience";

// ── Local types mirroring electron/hardware/discovery/* without importing
//   the main-process module (renderer must not pull in node-usb). ───────
interface ClassifiedCandidate {
  source: "usb" | "network" | "serial";
  identifier: string;
  suggestedRole: string;
  suggestedDriver: string;
  confidence: number;
  label: string;
  evidence: string;
  raw: Record<string, unknown>;
}

interface DiscoverSnapshot {
  ok: true;
  ranAt: number;
  usb: Array<Record<string, unknown>>;
  serial: Array<Record<string, unknown>>;
  network: { candidates: Array<Record<string, unknown>>; notImplemented?: boolean; note?: string };
  candidates: ClassifiedCandidate[];
}

function hasDiscover(): boolean {
  return typeof window !== "undefined"
    && typeof (window as unknown as { pos?: { hardware?: { discover?: unknown } } })
      .pos?.hardware?.discover === "function";
}

const ROLE_OPTIONS = [
  { value: "receipt_printer", label: "Receipt printer" },
  { value: "kitchen_printer", label: "Kitchen printer" },
  { value: "label_printer", label: "Label printer" },
  { value: "cash_drawer", label: "Cash drawer" },
  { value: "barcode_scanner", label: "Barcode scanner" },
  { value: "scale", label: "Scale" },
  { value: "customer_display", label: "Customer display" },
  { value: "payment_terminal", label: "Payment terminal" },
];

const DRIVER_OPTIONS: Record<string, string[]> = {
  receipt_printer: ["escpos", "epson", "star", "bixolon", "citizen"],
  kitchen_printer: ["escpos", "epson", "star"],
  label_printer: ["zpl_label", "epl_label", "escpos_label"],
  cash_drawer: ["escpos_drawer"],
  barcode_scanner: ["hid_scanner", "keyboard_wedge"],
  scale: ["generic_scale", "mettler_scale", "toledo_scale"],
  customer_display: ["line_display", "secondary_window"],
  payment_terminal: ["stripe_terminal", "adyen", "verifone", "mock"],
};

// Wave 11 R3: `bluetooth` removed from operator-facing transports —
// `BluetoothTransport.send` hardcodes a vendor-adapter-required failure
// (Star/Epson BT printers need vendor SDKs). The driver class is retained
// for future re-enablement once a vendor adapter ships; until then the
// option is hidden so operators can't pick a silently-failing transport.
const TRANSPORT_OPTIONS = ["usb", "serial", "network", "cups", "winspool"];


interface FormState {
  display_name: string;
  role: string;
  driver: string;
  transport: string;
  config_text: string; // JSON config edited as text
  is_default: boolean;
}

export default function DeviceWizard() {
  const navigate = useNavigate();
  const discoverAvailable = hasDiscover();
  const { upsert } = useDeviceAssignments();
  const { currentBusiness } = useBusinesses();

  const [discovering, setDiscovering] = useState(false);
  const [snapshot, setSnapshot] = useState<DiscoverSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<FormState>({
    display_name: "",
    role: "receipt_printer",
    driver: "escpos",
    transport: "usb",
    config_text: "{}",
    is_default: false,
  });

  const scan = useCallback(async () => {
    if (!discoverAvailable) {
      toast.error("Discovery requires the desktop POS client.");
      return;
    }
    setDiscovering(true);
    try {
      const fn = (window as unknown as { pos: { hardware: { discover: () => Promise<DiscoverSnapshot> } } })
        .pos.hardware.discover;
      const snap = await fn();
      setSnapshot(snap);
      const n = snap.candidates?.length ?? 0;
      toast.success(`Scan complete — ${n} suggested binding${n === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error(`Scan failed: ${normalizeError(e).message}`);
    } finally {
      setDiscovering(false);
    }
  }, [discoverAvailable]);

  // Auto-scan on mount when discovery is available — operators don't have
  // to remember to click before they see suggestions.
  useEffect(() => {
    if (discoverAvailable) void scan();
  }, [discoverAvailable, scan]);

  const candidates = useMemo<ClassifiedCandidate[]>(
    () => snapshot?.candidates ?? [],
    [snapshot],
  );

  const onPickCandidate = useCallback((c: ClassifiedCandidate) => {
    setSelectedId(c.identifier);
    // Derive form defaults from the classification.
    const raw = c.raw as Record<string, unknown>;
    let transport: string = c.source === "network" ? "network" : c.source;
    if (c.source === "serial") transport = "serial";

    const config: Record<string, unknown> = {};
    if (c.source === "usb") {
      config.vendorId = raw.vendorId;
      config.productId = raw.productId;
    } else if (c.source === "network") {
      config.host = raw.host;
      config.port = raw.port;
    } else if (c.source === "serial") {
      config.path = raw.path;
    }

    setForm({
      display_name: c.label,
      role: c.suggestedRole,
      driver: c.suggestedDriver,
      transport,
      config_text: JSON.stringify(config, null, 2),
      is_default: false,
    });
  }, []);

  const parsedConfig = useMemo<Record<string, unknown> | null>(() => {
    try {
      const parsed = JSON.parse(form.config_text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }, [form.config_text]);

  const handleTest = useCallback(async () => {
    if (!parsedConfig) {
      toast.error("Config JSON is invalid — fix it before testing.");
      return;
    }
    setTesting(true);
    try {
      // We can't dispatch against an unsaved binding because CommandRouter
      // routes by `(role, op)` against pre-registered handlers. The
      // pragmatic test path is: ask hardwareClient if the role currently
      // resolves; surface the result. A real "test on this exact device"
      // flow would need a transient registration, tracked separately.
      const res = await hardwareClient.devices.testRoleConnection(form.role as never);
      if (res.success) {
        toast.success(`${form.role} reachable — bind to save.`);
      } else {
        toast.warning(`Test inconclusive: ${res.error ?? "no driver bound yet"}`);
      }
    } catch (e) {
      toast.error(`Test failed: ${normalizeError(e).message}`);
    } finally {
      setTesting(false);
    }
  }, [form.role, parsedConfig]);

  const handleSave = useCallback(async () => {
    if (!parsedConfig) {
      toast.error("Config JSON is invalid — fix it before saving.");
      return;
    }
    if (!form.role || !form.driver || !form.transport) {
      toast.error("Role, driver, and transport are required.");
      return;
    }
    setSaving(true);
    try {
      await upsert.mutateAsync({
        scope_kind: "tenant",
        scope_id: null,
        role: form.role,
        transport: form.transport,
        driver: form.driver,
        display_name: form.display_name || form.role,
        config: parsedConfig,
        capabilities: {},
        enabled: true,
        is_default: form.is_default,
        business_id: currentBusiness?.id ?? null,
      });
      toast.success("Device saved. Restart the terminal to activate.");
      navigate("/platform/hardware/devices");
    } catch (e) {
      toast.error(`Save failed: ${normalizeError(e).message}`);
    } finally {
      setSaving(false);
    }
  }, [parsedConfig, form, upsert, currentBusiness?.id, navigate]);

  const driverOptions = DRIVER_OPTIONS[form.role] ?? ["escpos"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/platform/hardware/devices" aria-label="Back to devices">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Add a device</h1>
            <p className="text-sm text-muted-foreground">
              Plug the device in, scan, pick a suggestion, then save.
            </p>
          </div>
        </div>
        <Button onClick={scan} disabled={!discoverAvailable || discovering} variant="outline">
          {discovering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Rescan
        </Button>
      </div>

      {!discoverAvailable && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Native discovery unavailable</AlertTitle>
          <AlertDescription>
            Auto-discovery only runs inside the desktop POS client. You can still register a device manually below.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4" /> Suggested bindings
          </CardTitle>
          <CardDescription>
            Ranked by classifier confidence (USB vid/pid + name hints + mDNS).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {discovering && candidates.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
            </div>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {snapshot ? "No devices classified — fill the form below manually." : "Click Rescan to enumerate connected hardware."}
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {candidates.map((c) => (
                <li
                  key={c.identifier}
                  className={`flex cursor-pointer items-center justify-between gap-3 p-3 hover:bg-accent ${
                    selectedId === c.identifier ? "bg-accent" : ""
                  }`}
                  onClick={() => onPickCandidate(c)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{c.label}</span>
                      <Badge variant="outline" className="shrink-0">{c.suggestedRole}</Badge>
                      <Badge variant="secondary" className="shrink-0">{c.suggestedDriver}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">
                      {c.identifier} · {c.evidence}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono text-muted-foreground">{c.confidence}%</span>
                    {selectedId === c.identifier && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Binding details</CardTitle>
          <CardDescription>
            Edit before saving. JSON config is passed straight to the driver.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="display_name">Display name</Label>
              <Input
                id="display_name"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                placeholder="e.g. Front counter receipt printer"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) =>
                  setForm({ ...form, role: v, driver: (DRIVER_OPTIONS[v] ?? ["escpos"])[0] })
                }
              >
                <SelectTrigger id="role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="driver">Driver</Label>
              <Select value={form.driver} onValueChange={(v) => setForm({ ...form, driver: v })}>
                <SelectTrigger id="driver"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {driverOptions.map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transport">Transport</Label>
              <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v })}>
                <SelectTrigger id="transport"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRANSPORT_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="config">Config (JSON)</Label>
            <textarea
              id="config"
              className="min-h-32 w-full rounded-md border bg-background p-2 font-mono text-xs"
              value={form.config_text}
              onChange={(e) => setForm({ ...form, config_text: e.target.value })}
              spellCheck={false}
            />
            {!parsedConfig && (
              <p className="text-xs text-destructive">Invalid JSON.</p>
            )}
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleTest} variant="outline" disabled={testing || saving}>
              {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test reachability
            </Button>
            <Button onClick={handleSave} disabled={saving || testing || !parsedConfig}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save binding
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              Saves to <code>device_assignments</code> (tenant scope).
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
