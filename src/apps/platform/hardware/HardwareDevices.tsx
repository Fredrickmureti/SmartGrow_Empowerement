import { normalizeError } from "@/services/resilience";
/**
 * HardwareDevices — platform page for per-role device assignments.
 *
 * Wave 4 (Phase 2 closeout): the page now reads from the canonical
 * `device_assignments` table via `useDeviceAssignments`, so it renders
 * the same registry inside Electron AND in the browser / PWA. Previously
 * the page short-circuited to a "Browser preview" empty state whenever
 * `window.pos.devices` was missing, which was technically true for the
 * Electron-local SQLite cache but operationally a lie — the registry of
 * record lives in Supabase and is visible to every authenticated tab.
 *
 * Runtime split:
 *   - Read: Supabase `device_assignments` (works everywhere).
 *   - Test: `hardwareClient.exec(...)` → in Electron lands on
 *     `window.pos.hardware.exec` → CommandRouter → DeviceManager →
 *     CommandQueue → Transport → OS. In the browser it routes through
 *     the local agent or browser-native transports per
 *     `services/hardware/transport/index.ts`.
 *   - Remove: `useDeviceAssignments().remove` (Supabase). Wave 9b dropped
 *     the legacy `pos_hardware_configs` mirror, so removal is final.
 *
 * Architectural invariants this page upholds:
 *  - Single chokepoint: no direct `electronAPI.{usb,serial,…}` use; every
 *    hardware op goes through `hardwareClient`.
 *  - Idempotency: every test-button click stamps a traceable key.
 *  - Single registry: `device_assignments` (Phase 2). The Electron-local
 *    SQLite cache is a derived view hydrated by
 *    `ElectronAssignmentHydrator`, not an independent source of truth.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";

import { toast } from "sonner";
import { hardwareClient } from "@/services/hardware/HardwareClient";
import { runtimeCapability, type RuntimeCapability } from "@/services/hardware/HardwareClient";
import type { DeviceRole } from "@/services/hardware/drivers/DriverInterface";
import { useDeviceAssignments, type DeviceAssignment } from "@/hooks/useDeviceAssignments";
import { DeviceRegistryCard } from "@/components/hardware/DeviceRegistryCard";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Cpu, Radar, ListChecks, PlugZap } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { printLabelByTemplate } from "@/services/printing/labelDispatch";

const ROLE_LABELS: Record<string, { label: string; description: string }> = {
  receipt_printer: { label: "Receipt printer", description: "Customer receipt slips at sale commit." },
  kitchen_printer: { label: "Kitchen printer", description: "Order tickets routed to BOH stations." },
  cash_drawer: { label: "Cash drawer", description: "Kicked on cash tender or manual override." },
  scale: { label: "Scale", description: "Weight capture for variable-weight items." },
  customer_display: { label: "Customer display", description: "Pole / secondary screen for line totals." },
  payment_terminal: {
    label: "Payment terminal",
    description: "EMV / contactless capture via Stripe Terminal, Adyen, Verifone, or Square. Configure provider credentials in POS → Payment Terminals.",
  },
  barcode_scanner: { label: "Barcode scanner", description: "USB HID / Bluetooth keyboard-wedge devices." },
  scanner: { label: "Barcode scanner", description: "USB HID / Bluetooth keyboard-wedge devices." },
  label_printer: {
    label: "Label printer",
    description: "Thermal ZPL/EPL printers for product tags, shelf edges, receiving, pallets, and shipping.",
  },
};

const ROLE_ORDER: DeviceRole[] = [
  "receipt_printer",
  "kitchen_printer",
  "label_printer" as DeviceRole,
  "cash_drawer",
  "scale",
  "customer_display",
  "payment_terminal",
  "barcode_scanner" as DeviceRole,
];

interface TestSpec {
  op: string;
  payload: unknown;
  successCopy: string;
}

const TEST_OPS: Partial<Record<DeviceRole, TestSpec>> = {
  receipt_printer: {
    op: "print_receipt",
    payload: {
      lines: [
        { text: "*** TEST PRINT ***", align: "center", bold: true },
        { text: "Hardware Devices page", align: "center" },
        { text: new Date().toISOString(), align: "center" },
        { text: "" },
      ],
      cut: true,
    },
    successCopy: "Test slip sent.",
  },
  kitchen_printer: {
    op: "print_receipt",
    payload: {
      lines: [
        { text: "*** KITCHEN TEST ***", align: "center", bold: true },
        { text: "Hardware Devices page", align: "center" },
        { text: "" },
      ],
      cut: true,
    },
    successCopy: "Kitchen test ticket sent.",
  },
  cash_drawer: { op: "open", payload: { pin: 2 }, successCopy: "Drawer kick sent." },
  scale: { op: "read", payload: {}, successCopy: "Weight read." },
  customer_display: {
    op: "update",
    payload: { lines: ["TEST", new Date().toLocaleTimeString()] },
    successCopy: "Display updated.",
  },
  payment_terminal: {
    op: "initiate_payment",
    payload: { amount: 1, currency: "USD", reference: "hw-test" },
    successCopy: "Payment probe initiated — cancel from PED.",
  },
  // Label printer test dispatch is routed through printLabelByTemplate
  // (see handleTest) so it exercises the full workflow-binding + media
  // resolution pipeline, not just raw byte transport. This sentinel
  // entry only enables the Test button in the UI.
  label_printer: {
    op: "print_label",
    payload: { __templateDriven: true },
    successCopy: "Test label dispatched via product_label template.",
  },
};

function newId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function hasPosDevices(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as unknown as { pos?: { devices?: { list?: unknown } } }).pos?.devices?.list);
}

interface DiscoveredUsb {
  transport: 'usb';
  vendorId: number;
  productId: number;
  vendorIdHex: string;
  productIdHex: string;
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
}
interface DiscoveredSerial {
  transport: 'serial';
  path: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
}
interface DiscoverSnapshot {
  ok: true;
  ranAt: number;
  usb: DiscoveredUsb[];
  serial: DiscoveredSerial[];
  network: { candidates: unknown[]; notImplemented?: boolean; note?: string };
}

function hasDiscover(): boolean {
  return typeof window !== "undefined"
    && typeof (window as unknown as { pos?: { hardware?: { discover?: unknown } } })
      .pos?.hardware?.discover === "function";
}

export function HardwareDevicesPage() {
  const { assignments, isLoading, error, refetch, remove } = useDeviceAssignments();
  const { currentOrg, currentBranch } = useOrganization();

  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const electronAvailable = hasPosDevices();
  const discoverAvailable = hasDiscover();
  const [capability, setCapability] = useState<RuntimeCapability | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoverSnapshot | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void runtimeCapability().then((cap) => { if (alive) setCapability(cap); });
    return () => { alive = false; };
  }, []);

  const handleScan = useCallback(async () => {
    if (!discoverAvailable) {
      toast.error("Native device discovery is only available inside the desktop POS client.");
      return;
    }
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const fn = (window as unknown as { pos: { hardware: { discover: () => Promise<DiscoverSnapshot> } } })
        .pos.hardware.discover;
      const snap = await fn();
      setDiscovery(snap);
      const total = (snap.usb?.length ?? 0) + (snap.serial?.length ?? 0);
      toast.success(`Scan complete — ${total} device${total === 1 ? "" : "s"} detected.`);
    } catch (e) {
      const msg = normalizeError(e).message;
      setDiscoveryError(msg);
      toast.error(`Scan failed: ${msg}`);
    } finally {
      setDiscovering(false);
    }
  }, [discoverAvailable]);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed — clipboard unavailable");
    }
  }, []);

  const byRole = useMemo(() => {
    const map = new Map<string, DeviceAssignment[]>();
    for (const r of assignments) {
      const list = map.get(r.role) ?? [];
      list.push(r);
      map.set(r.role, list);
    }
    return map;
  }, [assignments]);

  const handleTest = useCallback(async (role: DeviceRole) => {
    const spec = TEST_OPS[role];
    if (!spec) {
      toast.info(`No test op defined for ${role}.`);
      return;
    }
    if (!electronAvailable) {
      toast.error("Test dispatch requires the desktop POS client or a running local agent.");
      return;
    }
    const key = `hw-test:${role}:${newId()}`;
    setTesting(key);
    try {
      // Label printers exercise the whole workflow-binding + media
      // resolution pipeline via printLabelByTemplate, so a "Test print"
      // here matches what the app actually dispatches at runtime.
      if ((role as string) === "label_printer") {
        if (!currentOrg?.id) {
          toast.error("Select an organization before test-printing a label.");
          return;
        }
        const res = await printLabelByTemplate({
          orgId: currentOrg.id,
          branchId: currentBranch?.id ?? null,
          templateKey: "product_label",
          workflow: "product_tag",
          vars: {
            name: "TEST LABEL",
            sku: "TEST-000",
            sku_display: "TEST-000",
            barcode: "000000000000",
            hri_flag: "N",
          },
          idempotencyKey: key,
          sourceDocType: "hardware_test",
          sourceDocId: key,
        });
        if (res.success) {
          const media = res.mediaResolved;
          toast.success(spec.successCopy, {
            description: media
              ? `Media ${media.widthMm}×${media.heightMm ?? "cont."} mm @ ${media.dpi} dpi (template v${res.templateResolved?.version}).`
              : undefined,
          });
        } else {
          toast.error(`Test failed: ${res.error ?? "unknown error"}`);
        }
        return;
      }
      const res = await hardwareClient.exec({
        role,
        op: spec.op,
        payload: spec.payload,
        idempotencyKey: key,
      });
      if (res.success) {
        toast.success(spec.successCopy);
      } else {
        toast.error(`Test failed: ${res.error ?? "unknown error"}`);
      }
    } catch (e) {
      toast.error(`Test failed: ${normalizeError(e).message}`);
    } finally {
      setTesting(null);
    }
  }, [electronAvailable, currentOrg?.id, currentBranch?.id]);

  const handleRemove = useCallback(async (id: string) => {
    setRemoving(id);
    try {
      await remove.mutateAsync(id);
      await refetch();
    } catch (e) {
      toast.error(normalizeError(e).message);
    } finally {
      setRemoving(null);
    }
  }, [remove, refetch]);

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="hardware-devices-page">

      {/* Compact page header + condensed runtime pill. Full runtime
          self-report moved into the Runtime tab so the primary editor
          surface is visible without scrolling. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Hardware devices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Register peripherals, bind them to roles, and dispatch audited test commands.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs" data-testid="hardware-runtime-pill">
            {capability
              ? capability.runtime === 'electron' ? 'Desktop POS'
                : capability.runtime === 'iot-agent' ? 'Local agent'
                : capability.runtime === 'browser' ? 'Browser / PWA'
                : 'Unsupported'
              : 'Probing…'}
          </Badge>
          {capability?.warnings.length ? (
            <Badge variant="outline" className="text-xs text-yellow-700 dark:text-yellow-400">
              {capability.warnings.length} warning{capability.warnings.length === 1 ? '' : 's'}
            </Badge>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link to="/platform/hardware/diagnostics">Diagnostics</Link>
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Failed to load assignments</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="register" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2 md:w-auto md:inline-grid md:grid-cols-4">
          <TabsTrigger value="register" data-testid="tab-register">
            <PlugZap className="mr-2 h-4 w-4" /> Register
          </TabsTrigger>
          <TabsTrigger value="assignments" data-testid="tab-assignments">
            <ListChecks className="mr-2 h-4 w-4" /> Assignments
            <Badge variant="secondary" className="ml-2">{assignments.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="discover" data-testid="tab-discover">
            <Radar className="mr-2 h-4 w-4" /> Discover
          </TabsTrigger>
          <TabsTrigger value="runtime" data-testid="tab-runtime">
            <Cpu className="mr-2 h-4 w-4" /> Runtime
          </TabsTrigger>
        </TabsList>

        {/* PRIMARY surface — the actual device editor is now the first
            thing operators see. No scrolling past info cards. */}
        <TabsContent value="register" className="space-y-4">
          <DeviceRegistryCard registerId={undefined} />
        </TabsContent>

        <TabsContent value="assignments" className="space-y-4">
          {!error && (
            <div className="space-y-4">
              {ROLE_ORDER.map((role) => {
                const meta = ROLE_LABELS[role] ?? { label: role, description: "" };
                const list = role === ("barcode_scanner" as DeviceRole)
                  ? [...(byRole.get("scanner") ?? []), ...(byRole.get("barcode_scanner") ?? [])]
                  : (byRole.get(role) ?? []);
                const spec = TEST_OPS[role];
                return (
                  <Card key={role} data-testid={`role-card-${role}`}>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base flex items-center gap-2">
                          {meta.label}
                          <Badge variant={list.length > 0 ? "default" : "outline"}>
                            {list.length > 0 ? `${list.length} assigned` : "unassigned"}
                          </Badge>
                          {role === "payment_terminal" && (
                            <Link
                              to="/pos/payment-terminals"
                              className="text-xs underline text-primary"
                              data-testid="configure-payment-terminal"
                            >
                              Configure provider
                            </Link>
                          )}
                        </CardTitle>
                        <CardDescription>{meta.description}</CardDescription>
                      </div>
                      {spec && list.length > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(testing) || !electronAvailable}
                          onClick={() => void handleTest(role)}
                          data-testid={`test-${role}`}
                          title={electronAvailable ? "Send a test dispatch" : "Open in the desktop POS client to send a test dispatch"}
                        >
                          Test
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent>
                      {isLoading ? (
                        <Skeleton className="h-12 w-full" />
                      ) : list.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No device bound. Add one from the Register tab.
                        </p>
                       ) : (
                         <div className="overflow-x-auto">
                         <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Transport</TableHead>
                              <TableHead>Driver</TableHead>
                              <TableHead>Scope</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Enabled</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {list.map((r) => (
                              <TableRow key={r.id} data-testid={`assignment-row-${r.id}`}>
                                <TableCell className="font-mono text-xs uppercase">{r.transport}</TableCell>
                                <TableCell className="font-mono text-xs">{r.driver}</TableCell>
                                <TableCell className="text-xs">
                                  {r.scope_kind}
                                  {r.scope_id ? `: ${r.scope_id.slice(0, 8)}…` : ""}
                                </TableCell>
                                <TableCell className="text-xs">
                                  <Badge variant={r.status === "online" ? "default" : "outline"}>
                                    {r.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <Badge variant={r.enabled ? "default" : "outline"}>
                                    {r.enabled ? "yes" : "no"}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={removing === r.id}
                                    onClick={() => void handleRemove(r.id)}
                                    data-testid={`remove-${r.id}`}
                                  >
                                    Remove
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                         </Table>
                         </div>
                       )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="discover" className="space-y-4">
          <Card data-testid="hardware-scan-card">
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Scan for devices</CardTitle>
                <CardDescription>
                  {discoverAvailable
                    ? "Enumerate USB and serial devices via the main process. Network broadcast discovery (mDNS) is not yet implemented — add network printers manually."
                    : "Native discovery is only available in the desktop POS client. In the browser, use the Register tab — WebUSB and WebSerial will prompt you to pick devices."}
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!discoverAvailable || discovering}
                onClick={() => void handleScan()}
                data-testid="hardware-scan-button"
              >
                {discovering ? "Scanning…" : "Scan now"}
              </Button>
            </CardHeader>
            {(discovery || discoveryError) && (
              <CardContent className="space-y-4">
                {discoveryError && (
                  <p className="text-sm text-destructive">Scan failed: {discoveryError}</p>
                )}
                {discovery && (
                  <>
                    <div>
                      <p className="text-sm font-medium mb-2">USB ({discovery.usb.length})</p>
                      {discovery.usb.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No USB devices detected.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Vendor</TableHead>
                              <TableHead>Product</TableHead>
                              <TableHead>VID</TableHead>
                              <TableHead>PID</TableHead>
                              <TableHead>Serial</TableHead>
                              <TableHead className="text-right">Copy</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {discovery.usb.map((d) => {
                              const id = `${d.vendorIdHex}:${d.productIdHex}:${d.serialNumber ?? ""}`;
                              return (
                                <TableRow key={id} data-testid={`scan-usb-${d.vendorIdHex}-${d.productIdHex}`}>
                                  <TableCell className="text-xs">{d.manufacturer ?? "—"}</TableCell>
                                  <TableCell className="text-xs">{d.product ?? "—"}</TableCell>
                                  <TableCell className="font-mono text-xs">{d.vendorIdHex}</TableCell>
                                  <TableCell className="font-mono text-xs">{d.productIdHex}</TableCell>
                                  <TableCell className="font-mono text-xs">{d.serialNumber ?? "—"}</TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => void copyToClipboard(
                                        JSON.stringify({
                                          transport: "usb",
                                          vendorId: d.vendorId,
                                          productId: d.productId,
                                          vendorIdHex: d.vendorIdHex,
                                          productIdHex: d.productIdHex,
                                          serialNumber: d.serialNumber ?? null,
                                          manufacturer: d.manufacturer ?? null,
                                          product: d.product ?? null,
                                        }, null, 2),
                                      )}
                                    >
                                      Copy
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium mb-2">Serial ({discovery.serial.length})</p>
                      {discovery.serial.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No serial devices detected.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Path</TableHead>
                              <TableHead>Manufacturer</TableHead>
                              <TableHead>Serial</TableHead>
                              <TableHead className="text-right">Copy</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {discovery.serial.map((d) => (
                              <TableRow key={d.path} data-testid={`scan-serial-${d.path}`}>
                                <TableCell className="font-mono text-xs">{d.path}</TableCell>
                                <TableCell className="text-xs">{d.manufacturer ?? "—"}</TableCell>
                                <TableCell className="font-mono text-xs">{d.serialNumber ?? "—"}</TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void copyToClipboard(JSON.stringify({ transport: "serial", path: d.path }, null, 2))}
                                  >
                                    Copy
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                    {discovery.network?.notImplemented && (
                      <p className="text-xs text-muted-foreground">
                        Network: {discovery.network.note ?? "Broadcast discovery not yet implemented — add manually."}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Scanned at {new Date(discovery.ranAt).toLocaleTimeString()}.
                    </p>
                  </>
                )}
              </CardContent>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="runtime" className="space-y-4">
          <Card data-testid="hardware-runtime-card">
        <CardHeader>
          <CardTitle className="text-base">
            Runtime: {capability
              ? capability.runtime === 'electron' ? 'Desktop POS (Electron IPC)'
                : capability.runtime === 'iot-agent' ? 'Browser via local IoT agent'
                : capability.runtime === 'browser' ? 'Browser / PWA (WebUSB/WebSerial)'
                : 'Unsupported runtime'
              : 'Probing…'}
            {capability?.preloadBuild ? (
              <span className="ml-2 text-xs font-mono text-muted-foreground">build {capability.preloadBuild}</span>
            ) : null}
          </CardTitle>
          <CardDescription>
            {capability ? (
              <>
                <span className="block mb-2">
                  Transports:{' '}
                  {(['usb','serial','hid','network','bluetooth','cups'] as const).map((t) => {
                    const s = capability.transports[t];
                    const color = s === 'native' ? 'text-foreground'
                      : s === 'degraded' ? 'text-yellow-600 dark:text-yellow-400'
                      : 'text-muted-foreground line-through';
                    return (
                      <span key={t} className={`mr-3 font-mono text-xs ${color}`}>
                        {t}:{s}
                      </span>
                    );
                  })}
                </span>
                {capability.warnings.length > 0 && (
                  <ul className="list-disc pl-5 mb-2 text-yellow-700 dark:text-yellow-400">
                    {capability.warnings.map((w) => <li key={w} className="text-xs">{w}</li>)}
                  </ul>
                )}
              </>
            ) : null}
            {electronAvailable
              ? 'Hardware commands route through the main-process CommandRouter (audited, queued, retried).'
              : 'Hardware commands route through WebUSB / WebSerial / WebHID or a running local agent (localhost:8043). Live test dispatches require either the desktop client or the agent.'}
            {' '}If something looks wrong, open{' '}
            <Link to="/platform/hardware/diagnostics" className="underline">
              hardware diagnostics
            </Link>
            {' '}for runtime decisions, preload fingerprint, and registry diff.
          </CardDescription>
        </CardHeader>
      </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default HardwareDevicesPage;
