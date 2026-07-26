import { normalizeError } from "@/services/resilience";
/**
 * Device Registry Card — Admin UI for managing POS hardware devices.
 * 
 * Provides:
 * - List of all registered devices with real-time status indicators
 * - Add new device dialog with role, driver, connection config
 * - Device discovery wizard (WebUSB, WebSerial, WebHID)
 * - Test connection per device
 * - Health status display with last-seen timestamps
 * - Edit/delete existing devices
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  useHardwareRegistryCrud,
  type CreateDeviceInput,
  type DeviceConfig,
} from "@/hooks/hardware/useHardwareRegistryCrud";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import { getHardwareCapabilities } from "@/lib/environment";
import type { DeviceRole, DriverType } from "@/services/hardware/drivers/DriverInterface";
import { getDriversForRole, getBackendsForDriver } from "@/services/hardware/drivers/DriverRegistry";
import { toast } from "sonner";
import { isElectron as isElectronEnv } from "@/lib/environment";
import { isPrivateIP } from "@/services/hardware/transport";
import { resolveTransport } from "@/services/hardware/transport";
import { hardwareClient } from "@/services/hardware/HardwareClient";

/**
 * Maps a functional DeviceRole to the canonical hardware_type stored in DB.
 * The DB check constraint allows: printer, cash_drawer, scale, customer_display, barcode_scanner, payment_terminal.
 */
const ROLE_TO_HARDWARE_TYPE: Record<DeviceRole, string> = {
  receipt_printer: 'printer',
  kitchen_printer: 'printer',
  label_printer: 'printer',
  a4_printer: 'printer',
  cash_drawer: 'cash_drawer',
  barcode_scanner: 'barcode_scanner',
  scanner: 'barcode_scanner',
  customer_display: 'customer_display',
  scale: 'scale',
  payment_terminal: 'payment_terminal',
  clock_terminal: 'clock_terminal',
  biometric_reader: 'biometric_reader',
  saga: 'saga',
};

/**
 * Maps driver/browser backend names to DB-allowed connection_type values.
 * The DB check constraint allows: usb, network, serial, bluetooth, browser.
 */
const BACKEND_TO_CONNECTION_TYPE: Record<string, string> = {
  network: 'network',
  webusb: 'usb',
  webserial: 'serial',
  electron: 'usb',
  browser: 'browser',
  local_proxy: 'network',
  // pass-through for already-canonical values
  usb: 'usb',
  serial: 'serial',
  bluetooth: 'bluetooth',
};
import { formatDistanceToNow } from "date-fns";
import {
  Printer, Scale, Wallet, Monitor, ScanBarcode, CreditCard, Tag,
  Plus, Trash2, Settings, Wifi, WifiOff, AlertCircle, CheckCircle2,
  RefreshCw, Activity, Search, Zap, TestTube, Clock, Pencil, AlertTriangle,
} from "lucide-react";

/**
 * Stage I (H7) — printers whose driver/DIP setting auto-kicks the cash drawer
 * on every receipt print defeat the per-register `auto_open_drawer_on_*` policy.
 * If the device row's `capabilities` array advertises this trait, render a
 * warning chip on the card so operators know to disable it at the device.
 */
const AUTO_KICK_CAPABILITY = "auto_kick_on_print";
function deviceAutoKicksOnPrint(capabilities: string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(AUTO_KICK_CAPABILITY);
}

const ROLE_OPTIONS: { value: DeviceRole; label: string; icon: React.ReactNode; hint?: string }[] = [
  { value: 'receipt_printer', label: 'Receipt Printer', icon: <Printer className="h-4 w-4" /> },
  { value: 'kitchen_printer', label: 'Kitchen Printer', icon: <Printer className="h-4 w-4" />, hint: 'Prints kitchen orders (KDS)' },
  { value: 'cash_drawer', label: 'Cash Drawer', icon: <Wallet className="h-4 w-4" /> },
  { value: 'barcode_scanner', label: 'Barcode Scanner', icon: <ScanBarcode className="h-4 w-4" /> },
  { value: 'customer_display', label: 'Customer Display', icon: <Monitor className="h-4 w-4" /> },
  { value: 'scale', label: 'Weighing Scale', icon: <Scale className="h-4 w-4" /> },
  { value: 'payment_terminal', label: 'Payment Terminal', icon: <CreditCard className="h-4 w-4" />, hint: '⚠️ Integration pending' },
  { value: 'label_printer', label: 'Label Printer', icon: <Tag className="h-4 w-4" /> },
];

/** Dynamic: derive driver options from the DriverRegistry instead of hardcoding */
function getDriverOptionsForRole(role: DeviceRole): { value: DriverType; label: string }[] {
  return getDriversForRole(role).map(d => ({ value: d.driverType, label: d.label }));
}

/**
 * Dynamic: derive connection types from the selected driver's supportedBackends.
 * Filters out transport-level details (local_proxy) that are runtime decisions,
 * not user-facing connection types. Transport selection is handled by resolveTransport().
 */
function getConnectionTypesForDriver(driverType: DriverType): { value: string; label: string }[] {
  const backends = getBackendsForDriver(driverType);
  const labelMap: Record<string, string> = {
    network: 'Network (IP/Port)',
    webusb: 'USB',
    electron: 'Native (Electron)',
    webserial: 'Serial (RS-232)',
    browser: 'Browser (Direct HTTP / Simulated)',
  };
  // Filter out local_proxy — it's a transport detail, not a connection type
  return backends
    .filter(b => b !== 'local_proxy')
    .map(b => ({ value: b, label: labelMap[b] || b }));
}

// Fallback connection types for when no driver is selected
const DEFAULT_CONNECTION_TYPES = [
  { value: 'network', label: 'Network (IP/Port)' },
  { value: 'usb', label: 'USB' },
  { value: 'serial', label: 'Serial (RS-232)' },
  { value: 'bluetooth', label: 'Bluetooth' },
  { value: 'browser', label: 'Browser (Simulated)' },
];

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'online':
      return <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />Online</Badge>;
    case 'error':
      return <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Error</Badge>;
    case 'configuring':
      return <Badge variant="secondary" className="gap-1"><Settings className="h-3 w-3 animate-spin" />Configuring</Badge>;
    case 'unreachable':
      return <Badge variant="destructive" className="gap-1"><WifiOff className="h-3 w-3" />Unreachable</Badge>;
    case 'offline':
      return <Badge variant="outline" className="gap-1"><WifiOff className="h-3 w-3" />Offline</Badge>;
    default:
      return <Badge variant="outline" className="gap-1"><AlertCircle className="h-3 w-3" />Unknown</Badge>;
  }
}

function getRoleIcon(role: string) {
  const found = ROLE_OPTIONS.find(r => r.value === role);
  return found?.icon ?? <Settings className="h-4 w-4" />;
}

interface DeviceRegistryCardProps {
  registerId?: string;
}

export function DeviceRegistryCard({ registerId }: DeviceRegistryCardProps) {
  const id = useRef(`DeviceRegistryCard-${Date.now()}-${Math.random()}`).current;
  console.log(`[LIFECYCLE] DeviceRegistryCard RENDERING (${id})`, { registerId });

  const { devices, isLoading, createDevice, deleteDevice, updateDevice, updateDeviceStatus } = useHardwareRegistryCrud(registerId);
  // Single hook instance — calling useHardwareProxy twice in the same
  // component duplicated React Query subscriptions, started the agent
  // probe loop twice, and was a primary cause of the POS Settings render
  // saturation when localhost:8043 was unreachable.
  const { refreshStatuses, testRoleConnection, agentAvailable } = useHardwareProxy(registerId);
  const capabilities = getHardwareCapabilities();
  const isElectronRuntime = hardwareClient.devices.isElectron();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showDiscoveryDialog, setShowDiscoveryDialog] = useState(false);
  const [formData, setFormData] = useState<Partial<CreateDeviceInput>>({
    device_role: 'receipt_printer',
    driver_type: 'escpos',
    connection_type: 'network',
    connection_params: { ipAddress: '', port: 9100 },
    display_name: '',
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<DeviceConfig | null>(null);

  useEffect(() => {
    console.log(`[LIFECYCLE] DeviceRegistryCard MOUNTED (${id})`);
    return () => {
      console.log(`[LIFECYCLE] DeviceRegistryCard UNMOUNTING (${id})`);
    };
  }, [id]);

  const handleAdd = () => {
    if (!formData.display_name || !formData.device_role || !formData.driver_type) {
      toast.error("Please fill in all required fields");
      return;
    }

    const canonicalConnectionType = BACKEND_TO_CONNECTION_TYPE[formData.connection_type || 'network'] || 'network';

    // Validate network connection params before persisting — silently dropping
    // port/IP causes the device to never connect and silently routes prints to PDF.
    if (canonicalConnectionType === 'network') {
      const ip = (formData.connection_params?.ipAddress as string | undefined)?.trim();
      const port = formData.connection_params?.port as number | undefined;
      if (!ip) {
        toast.error("IP Address is required for a network printer");
        return;
      }
      if (!port || !Number.isFinite(port) || port <= 0 || port > 65535) {
        toast.error("A valid Port (1–65535) is required for a network printer");
        return;
      }
    }

    createDevice.mutate({
      display_name: formData.display_name!,
      hardware_type: ROLE_TO_HARDWARE_TYPE[formData.device_role as DeviceRole] || 'printer',
      connection_type: canonicalConnectionType,
      connection_params: formData.connection_params || {},
      device_role: formData.device_role as DeviceRole,
      driver_type: formData.driver_type as DriverType,
      register_id: registerId,
      is_default: true,
    }, {
      onSuccess: () => {
        setShowAddDialog(false);
        setFormData({
          device_role: 'receipt_printer',
          driver_type: 'escpos',
          connection_type: 'network',
          connection_params: { ipAddress: '', port: 9100 },
          display_name: '',
        });
      },
    });
  };

  const handleDelete = (id: string) => {
    if (deletingId === id) {
      deleteDevice.mutate(id);
      setDeletingId(null);
    } else {
      setDeletingId(id);
      setTimeout(() => setDeletingId(null), 3000);
    }
  };

  const handleTestConnection = useCallback(async (device: DeviceConfig) => {
    setTestingId(device.id);
    try {
      const params = device.connection_params || {};
      const ipAddress = params.ipAddress as string | undefined;
      const port = params.port as number | undefined;
      const connType = device.connection_type;
      const driverType = device.driver_type;

      // ePOS printers: test via direct HTTP (browser → printer)
      if (driverType === 'epos_printer' && ipAddress) {
        try {
          const { EposPrinterDriver } = await import('@/services/hardware/drivers/EposPrinterDriver');
          const driver = new EposPrinterDriver();
          const connectResult = await driver.connect({
            ipAddress,
            port: port || 443,
            useSsl: params.useSsl !== false,
          });
          updateDeviceStatus.mutate({
            id: device.id,
            status: connectResult.success ? 'online' : 'error',
            lastError: connectResult.error,
          });
          toast[connectResult.success ? 'success' : 'error'](
            connectResult.success
              ? `${device.display_name} ePOS endpoint is online`
              : `${device.display_name}: ${connectResult.error || 'ePOS connection failed'}`
          );
        } catch (err) {
          updateDeviceStatus.mutate({ id: device.id, status: 'error', lastError: (err as Error).message });
          toast.error(`ePOS test failed: ${normalizeError(err).message}`);
        }
        refreshStatuses();
        return;
      }

      // Network devices: route through unified transport layer
      if (connType === 'network') {
        if (!ipAddress || !port) {
          toast.error(
            `${device.display_name}: missing ${!ipAddress ? 'IP Address' : 'Port'}. Edit the device and set a valid IP/Port.`,
          );
          updateDeviceStatus.mutate({
            id: device.id,
            status: 'error',
            lastError: !ipAddress ? 'Missing IP Address' : 'Missing Port',
          });
          refreshStatuses();
          return;
        }
        const transport = resolveTransport({
          connectionType: 'network',
          ipAddress,
          port,
        });

        if (!transport) {
          toast.error('No transport available. Install the Print Agent or use Electron.');
          updateDeviceStatus.mutate({ id: device.id, status: 'error', lastError: 'No transport available' });
          refreshStatuses();
          return;
        }

        if (!transport.isAvailable()) {
          toast.error(
            `${transport.name} not available. Ensure the Print Agent is running or use Electron.`,
            { duration: 8000 }
          );
          updateDeviceStatus.mutate({ id: device.id, status: 'error', lastError: `${transport.name} not available` });
          refreshStatuses();
          return;
        }

        const result = await transport.test();
        updateDeviceStatus.mutate({
          id: device.id,
          status: result.success ? 'online' : 'error',
          lastError: result.error,
        });
        toast[result.success ? 'success' : 'error'](
          result.success
            ? `${device.display_name} is online (via ${transport.name})`
            : `${device.display_name}: ${result.error || 'Connection failed'}`
        );
        await transport.disconnect();
      } else {
        // For non-network devices, route through the hardwareClient — in Electron
        // this re-probes via DeviceManager; in the browser it falls back to the
        // adapter's per-role driver. UI never touches the renderer-side adapter
        // directly (Track H4 — enforced by the no-legacy-hardware-shell guard).
        const role = (device.device_role || device.hardware_type) as DeviceRole;
        const res = await testRoleConnection(role);
        updateDeviceStatus.mutate({
          id: device.id,
          status: res.success ? 'online' : 'error',
          lastError: res.error,
        });
        toast[res.success ? 'success' : 'error'](
          res.success
            ? `${device.display_name} is online`
            : `${device.display_name}: ${res.error || 'Connection failed'}`,
        );
      }
      refreshStatuses();
    } catch (err) {
      updateDeviceStatus.mutate({
        id: device.id,
        status: 'error',
        lastError: (err as Error).message,
      });
      toast.error(`Test failed: ${normalizeError(err).message}`);
    } finally {
      setTestingId(null);
    }
  }, [refreshStatuses, testRoleConnection, updateDeviceStatus]);

  // Device discovery using browser APIs
  const handleDiscoverUSB = async () => {
    if (!(navigator as any).usb) {
      toast.error("WebUSB is not supported in this browser");
      return;
    }
    try {
      const device = await (navigator as any).usb.requestDevice({ filters: [] });
      setFormData(prev => ({
        ...prev,
        display_name: device.productName || `USB Device (${device.vendorId.toString(16)}:${device.productId.toString(16)})`,
        connection_type: 'usb',
        device_role: 'receipt_printer',
        driver_type: 'escpos',
        connection_params: {
          vendorId: device.vendorId,
          productId: device.productId,
        },
      }));
      setShowDiscoveryDialog(false);
      setShowAddDialog(true);
      toast.success(`Found: ${device.productName || 'USB Device'}`);
    } catch {
      // User cancelled picker
    }
  };

  const handleDiscoverSerial = async () => {
    if (!('serial' in navigator)) {
      toast.error("Web Serial is not supported in this browser");
      return;
    }
    try {
      const port = await (navigator as any).serial.requestPort();
      const info = port.getInfo?.() || {};
      setFormData(prev => ({
        ...prev,
        display_name: `Serial Device (${info.usbVendorId?.toString(16) || 'unknown'})`,
        connection_type: 'serial',
        device_role: undefined, // Don't assume — let user pick
        driver_type: undefined,
        connection_params: {
          baudRate: 9600,
          vendorId: info.usbVendorId,
          productId: info.usbProductId,
        },
      }));
      setShowDiscoveryDialog(false);
      setShowAddDialog(true);
      toast.success("Serial port selected");
    } catch {
      // User cancelled picker
    }
  };

  const handleDiscoverHID = async () => {
    if (!('hid' in navigator)) {
      toast.error("WebHID is not supported in this browser");
      return;
    }
    try {
      const devices = await (navigator as any).hid.requestDevice({ filters: [] });
      if (devices.length > 0) {
        const device = devices[0];
        setFormData(prev => ({
          ...prev,
          display_name: device.productName || `HID Device (${device.vendorId.toString(16)})`,
          connection_type: 'usb',
          device_role: 'barcode_scanner',
          driver_type: 'hid_scanner',
          connection_params: {
            vendorId: device.vendorId,
            productId: device.productId,
          },
        }));
        setShowDiscoveryDialog(false);
        setShowAddDialog(true);
        toast.success(`Found: ${device.productName || 'HID Device'}`);
      }
    } catch {
      // User cancelled picker
    }
  };

  const availableDrivers = formData.device_role
    ? getDriverOptionsForRole(formData.device_role as DeviceRole)
    : [];
  const availableConnections = formData.driver_type
    ? getConnectionTypesForDriver(formData.driver_type as DriverType)
    : DEFAULT_CONNECTION_TYPES;

  // Local agent state — browser/dev path. In Electron the entire IoT-Box
  // sub-card is hidden (the main-process CommandRouter owns hardware IO).
  const [agentUrl, setAgentUrl] = useState(hardwareClient.agent.getBaseUrl() || 'http://localhost:8043');
  const [agentToken, setAgentToken] = useState(hardwareClient.agent.getToken() || '');
  const [agentTesting, setAgentTesting] = useState(false);
  // agentAvailable comes from the top-level useHardwareProxy() call above.
  // Do NOT call useHardwareProxy here — it would duplicate React Query
  // subscriptions and start the agent probe loop a second time.

  const handleTestAgent = useCallback(async () => {
    setAgentTesting(true);
    try {
      hardwareClient.agent.setBaseUrl(agentUrl);
      hardwareClient.agent.setToken(agentToken || null);
      const status = await hardwareClient.agent.probe();
      if (!status?.running) {
        toast.error(`Agent not reachable at ${agentUrl}. Is it running?`);
        return;
      }
      if (!hardwareClient.agent.isAuthorized()) {
        // Distinguish the three failure modes — they need different fixes.
        const reason = hardwareClient.agent.getAuthReason();
        if (reason === 'blocked') {
          toast.error(
            'Agent answered, but this browser blocked the authorized request. An HTTPS page cannot call a plain-HTTP agent: install the agent\'s loopback certificate, or open the ERP over http://localhost.',
            { duration: 10000 },
          );
        } else if (reason === 'missing_token') {
          toast.error(
            'Agent requires a pairing token. Open AccrualFlow Edge → Identity → Browser pairing and copy the pairing token (not the workstation secret).',
            { duration: 10000 },
          );
        } else {
          toast.error(
            'Agent rejected this token. Use the pairing token from AccrualFlow Edge → Identity → Browser pairing (or ~/.pos-agent-token) — the workstation secret from enrolment will not work here.',
            { duration: 10000 },
          );
        }
        return;
      }
      toast.success(`Agent v${status.version} authorized (${status.devices?.length || 0} devices discovered)`);
    } catch {
      toast.error(`Agent not reachable at ${agentUrl}`);
    } finally {
      setAgentTesting(false);
    }
  }, [agentUrl, agentToken]);

  // Loopback test: send canonical INIT + "Hello from POS" + cut to a printer.
  // Useful when pointing at the local ESC/POS emulator on 127.0.0.1:9100
  // without having to ring a real sale.
  const [loopbackIp, setLoopbackIp] = useState("127.0.0.1");
  const [loopbackPort, setLoopbackPort] = useState("9100");
  const [loopbackBusy, setLoopbackBusy] = useState(false);

  const handleLoopbackPrint = useCallback(async () => {
    const port = Number(loopbackPort);
    if (!loopbackIp || !Number.isFinite(port) || port <= 0) {
      toast.error("Enter a valid IP and port");
      return;
    }
    setLoopbackBusy(true);
    try {
      hardwareClient.agent.setBaseUrl(agentUrl);
      hardwareClient.agent.setToken(agentToken || null);
      // ESC @ (init) | "*** POS LOOPBACK TEST ***\n" | LF LF LF | GS V 0 (full cut)
      const header = "*** POS LOOPBACK TEST ***\nHello from the POS hardware page.\n";
      const bytes: number[] = [0x1b, 0x40];
      for (let i = 0; i < header.length; i++) bytes.push(header.charCodeAt(i) & 0xff);
      bytes.push(0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00);
      const result = await hardwareClient.agent.testPrintNetwork(loopbackIp, port, bytes);
      if (result.success) {
        toast.success(`Sent ${result.bytesWritten ?? bytes.length} bytes to ${loopbackIp}:${port}`);
      } else {
        toast.error(`Loopback print failed: ${result.error || "unknown error"}`, { duration: 8000 });
      }
    } catch (err) {
      toast.error(`Loopback print failed: ${normalizeError(err).message}`);
    } finally {
      setLoopbackBusy(false);
    }
  }, [agentUrl, agentToken, loopbackIp, loopbackPort]);

  return (
    <div className="space-y-4">
      {/* IoT Box Agent Configuration — browser path only. In Electron the
          main-process CommandRouter owns hardware IO, so this sub-card is
          hidden to keep operators from configuring something that isn't used. */}
      {!isElectronRuntime && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wifi className="h-4 w-4" />
            IoT Box Agent
          </CardTitle>
          <CardDescription className="text-xs">
            Local agent that bridges the browser to USB/network hardware
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                placeholder="http://localhost:8043"
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                className="flex-1 text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestAgent}
                disabled={agentTesting}
              >
                {agentTesting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <TestTube className="h-4 w-4" />}
              </Button>
              <Badge variant={agentAvailable ? 'default' : 'outline'} className="gap-1 shrink-0">
                {agentAvailable ? <CheckCircle2 className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {agentAvailable ? (hardwareClient.agent.isAuthorized() ? 'Authorized' : 'Online (no token)') : 'Offline'}
              </Badge>
            </div>
            <Input
              type="password"
              placeholder="Pairing token — Edge app → Identity → Browser pairing"
              value={agentToken}
              onChange={(e) => setAgentToken(e.target.value)}
              className="text-sm font-mono"
            />
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Paste the <strong>pairing token</strong> from <strong>AccrualFlow Edge → Identity → Browser pairing</strong>
                {' '}(same value as <code>~/.pos-agent-token</code>). This is <strong>not</strong> the workstation secret
                shown during enrolment — that one authenticates the device to AccrualFlow and the agent will reject it.
              </p>
              <p>
                Network printers and USB devices are reached through this agent — point the URL at a LAN agent to share
                hardware across terminals. In development, <code>npm run agent:dev</code> disables auth and the token can
                be left blank.
              </p>
            </div>
          </div>

          <Separator className="my-3" />

          <div className="space-y-2">
            <Label className="text-xs font-medium">Loopback test print</Label>
            <p className="text-xs text-muted-foreground">
              Sends a canonical ESC/POS init + "Hello" + cut to any printer
              (or simulator like the ESC/POS emulator on <code>127.0.0.1:9100</code>)
              through the agent. Bypasses the receipt pipeline so you can verify
              the agent → printer link without ringing a sale.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="127.0.0.1"
                value={loopbackIp}
                onChange={(e) => setLoopbackIp(e.target.value)}
                className="w-40 text-sm"
              />
              <Input
                placeholder="9100"
                value={loopbackPort}
                onChange={(e) => setLoopbackPort(e.target.value)}
                className="w-24 text-sm"
              />
              <Button
                size="sm"
                onClick={handleLoopbackPrint}
                disabled={loopbackBusy || !agentAvailable}
              >
                {loopbackBusy ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
                Send test print
              </Button>
            </div>
            {!agentAvailable && (
              <p className="text-xs text-amber-600">
                Agent is offline — start it with <code>AGENT_AUTH_DISABLED=1 npm --prefix agent run dev</code>.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      )}



      {/* Environment Capabilities */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Hardware Capabilities
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge variant={capabilities.isElectron ? "default" : "secondary"}>
              {capabilities.isElectron ? "Desktop App" : "Web Browser"}
            </Badge>
            <Badge variant={capabilities.webUSB ? "default" : "outline"} className="gap-1">
              {capabilities.webUSB ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              WebUSB
            </Badge>
            <Badge variant={capabilities.webSerial ? "default" : "outline"} className="gap-1">
              {capabilities.webSerial ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              WebSerial
            </Badge>
            <Badge variant="default" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Network
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Device Registry */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Device Registry
              </CardTitle>
              <CardDescription>
                Manage hardware devices connected to this POS register
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {/* Scan for Devices */}
              <Dialog open={showDiscoveryDialog} onOpenChange={setShowDiscoveryDialog}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Search className="h-4 w-4 mr-2" />
                    Scan
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Scan for Devices</DialogTitle>
                    <DialogDescription>
                      Use browser APIs to detect connected hardware. Your browser will show a device picker.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <Button
                      variant="outline"
                      className="w-full justify-start gap-3 h-auto py-3"
                      onClick={handleDiscoverUSB}
                      disabled={!capabilities.webUSB}
                    >
                      <Printer className="h-5 w-5 shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">USB Devices</div>
                        <div className="text-xs text-muted-foreground">Printers, drawers (WebUSB)</div>
                      </div>
                      {!capabilities.webUSB && <Badge variant="outline" className="ml-auto text-xs">Unavailable</Badge>}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full justify-start gap-3 h-auto py-3"
                      onClick={handleDiscoverSerial}
                      disabled={!capabilities.webSerial}
                    >
                      <Scale className="h-5 w-5 shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">Serial Devices</div>
                        <div className="text-xs text-muted-foreground">Scales, displays (RS-232)</div>
                      </div>
                      {!capabilities.webSerial && <Badge variant="outline" className="ml-auto text-xs">Unavailable</Badge>}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full justify-start gap-3 h-auto py-3"
                      onClick={handleDiscoverHID}
                      disabled={!('hid' in navigator)}
                    >
                      <ScanBarcode className="h-5 w-5 shrink-0" />
                      <div className="text-left">
                        <div className="font-medium">HID Devices</div>
                        <div className="text-xs text-muted-foreground">Barcode scanners (WebHID)</div>
                      </div>
                      {!('hid' in navigator) && <Badge variant="outline" className="ml-auto text-xs">Unavailable</Badge>}
                    </Button>
                  </div>
                  <Separator />
                  <p className="text-xs text-muted-foreground">
                    Network devices (IP printers, payment terminals) should be added manually using "Add Device."
                  </p>
                </DialogContent>
              </Dialog>

              {/* Add Device manually */}
              <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-2" />
                    Add Device
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Register New Device</DialogTitle>
                    <DialogDescription>
                      Add a hardware device to this POS register
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Device Name</Label>
                      <Input
                        placeholder="e.g., Kitchen Printer, Main Scale"
                        value={formData.display_name || ''}
                        onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Device Role</Label>
                      <Select
                        value={formData.device_role}
                        onValueChange={(v) => {
                          const role = v as DeviceRole;
                          const drivers = getDriverOptionsForRole(role);
                          setFormData(prev => ({
                            ...prev,
                            device_role: role,
                            driver_type: drivers[0]?.value,
                          }));
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              <div className="flex items-center gap-2">
                                {opt.icon}
                                {opt.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Driver</Label>
                      <Select
                        value={formData.driver_type}
                        onValueChange={(v) => setFormData(prev => ({ ...prev, driver_type: v as DriverType }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableDrivers.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Connection Type</Label>
                      <Select
                        value={formData.connection_type}
                        onValueChange={(v) => setFormData(prev => ({ ...prev, connection_type: v }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableConnections.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Network connection fields */}
                    {(formData.connection_type === 'network') && (
                      <div className="grid grid-cols-2 gap-4 p-3 bg-muted/50 rounded-lg border">
                        <div className="space-y-2">
                          <Label>IP Address</Label>
                          <Input
                            placeholder="192.168.1.100"
                            value={(formData.connection_params?.ipAddress as string) || ''}
                            onChange={(e) => setFormData(prev => ({
                              ...prev,
                              connection_params: { ...prev.connection_params, ipAddress: e.target.value },
                            }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Port</Label>
                          <Input
                            type="number"
                            placeholder="9100"
                            value={
                              formData.connection_params?.port == null
                                ? ''
                                : String(formData.connection_params.port)
                            }
                            onChange={(e) => {
                              const raw = e.target.value;
                              const parsed = raw === '' ? undefined : parseInt(raw, 10);
                              setFormData(prev => ({
                                ...prev,
                                connection_params: {
                                  ...prev.connection_params,
                                  port: Number.isFinite(parsed as number) ? parsed : undefined,
                                },
                              }));
                            }}
                          />
                        </div>
                        {/* Private IP warning in browser mode */}
                        {!isElectronEnv() && formData.connection_params?.ipAddress && isPrivateIP(formData.connection_params.ipAddress as string) && (
                          <div className="col-span-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700">
                            <strong>Local network detected.</strong> This printer requires the Print Agent or Electron desktop app. The cloud cannot reach private IPs directly.
                          </div>
                        )}
                      </div>
                    )}

                    {/* ePOS-specific connection fields */}
                    {formData.driver_type === 'epos_printer' && (
                      <div className="space-y-4 p-3 bg-muted/50 rounded-lg border">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Printer IP Address</Label>
                            <Input
                              placeholder="192.168.1.50"
                              value={(formData.connection_params?.ipAddress as string) || ''}
                              onChange={(e) => setFormData(prev => ({
                                ...prev,
                                connection_params: { ...prev.connection_params, ipAddress: e.target.value },
                              }))}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Port</Label>
                            <Input
                              type="number"
                              placeholder="443"
                              value={(formData.connection_params?.port as string) || '443'}
                              onChange={(e) => setFormData(prev => ({
                                ...prev,
                                connection_params: { ...prev.connection_params, port: parseInt(e.target.value, 10) },
                              }))}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Epson ePOS printers communicate via HTTP/HTTPS directly from the browser. No print agent needed. Ensure the printer has a static IP and ePOS firmware enabled.
                        </p>
                      </div>
                    )}

                    {/* Serial connection fields */}
                    {formData.connection_type === 'serial' && (
                      <div className="grid grid-cols-2 gap-4 p-3 bg-muted/50 rounded-lg border">
                        <div className="space-y-2">
                          <Label>Baud Rate</Label>
                          <Select
                            value={String(formData.connection_params?.baudRate || 9600)}
                            onValueChange={(v) => setFormData(prev => ({
                              ...prev,
                              connection_params: { ...prev.connection_params, baudRate: parseInt(v, 10) },
                            }))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="4800">4800</SelectItem>
                              <SelectItem value="9600">9600</SelectItem>
                              <SelectItem value="19200">19200</SelectItem>
                              <SelectItem value="38400">38400</SelectItem>
                              <SelectItem value="115200">115200</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>

                  <DialogFooter>
                    <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
                    <Button onClick={handleAdd} disabled={createDevice.isPending}>
                      {createDevice.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
                      Register Device
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              Loading devices...
            </div>
          ) : devices.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Settings className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No devices registered yet</p>
              <p className="text-sm mt-1">Click "Scan" to detect hardware or "Add Device" to register manually</p>
            </div>
          ) : (
            <div className="space-y-3">
              {devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-md bg-muted shrink-0">
                      {getRoleIcon(device.device_role || device.hardware_type)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{device.display_name}</span>
                        {device.is_default && (
                          <Badge variant="outline" className="text-xs shrink-0">Default</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        <span className="capitalize">{device.device_role?.replace(/_/g, ' ') || device.hardware_type}</span>
                        <span>•</span>
                        <span>{device.driver_type || 'generic'}</span>
                        <span>•</span>
                        <span className="capitalize">{device.connection_type}</span>
                        {device.connection_params?.ipAddress && (
                          <>
                            <span>•</span>
                            <span>{String(device.connection_params.ipAddress)}:{String(device.connection_params.port || '')}</span>
                          </>
                        )}
                      </div>
                      {/* Last seen + error */}
                      <div className="flex items-center gap-2 mt-0.5">
                        {device.last_seen_at && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDistanceToNow(new Date(device.last_seen_at), { addSuffix: true })}
                          </span>
                        )}
                        {device.last_error && (
                          <span className="text-[10px] text-destructive truncate max-w-[200px]">{device.last_error}</span>
                        )}
                      </div>
                      {/* Stage I (H7) — Drawer-policy hazard chip */}
                      {deviceAutoKicksOnPrint(device.capabilities) && (
                        <div className="mt-1.5">
                          <Badge variant="destructive" className="gap-1 text-[10px] font-normal">
                            <AlertTriangle className="h-3 w-3" />
                            Printer auto-opens drawer on every print — disable at the device DIP/utility tool to honor cash-only policy.
                          </Badge>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={device.status} />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleTestConnection(device)}
                      disabled={testingId === device.id}
                      title="Test Connection"
                    >
                      {testingId === device.id ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <TestTube className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        setEditingDevice(device);
                        setFormData({
                          display_name: device.display_name,
                          device_role: (device.device_role || undefined) as DeviceRole | undefined,
                          driver_type: (device.driver_type || undefined) as DriverType | undefined,
                          connection_type: device.connection_type,
                          connection_params: device.connection_params,
                        });
                      }}
                      title="Edit Device"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant={deletingId === device.id ? "destructive" : "ghost"}
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDelete(device.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Device Dialog */}
      <Dialog open={!!editingDevice} onOpenChange={(open) => { if (!open) setEditingDevice(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Device</DialogTitle>
            <DialogDescription>
              Update the role, driver, or connection settings for this device
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Device Name</Label>
              <Input
                value={formData.display_name || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Device Role</Label>
              <Select
                value={formData.device_role}
                onValueChange={(v) => {
                  const role = v as DeviceRole;
                  const drivers = getDriverOptionsForRole(role);
                  setFormData(prev => ({
                    ...prev,
                    device_role: role,
                    driver_type: drivers[0]?.value,
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a role..." />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <div className="flex items-center gap-2">
                        {opt.icon}
                        {opt.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Driver</Label>
              <Select
                value={formData.driver_type}
                onValueChange={(v) => setFormData(prev => ({ ...prev, driver_type: v as DriverType }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a driver..." />
                </SelectTrigger>
                <SelectContent>
                  {availableDrivers.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Connection Type</Label>
              <Select
                value={formData.connection_type}
                onValueChange={(v) => setFormData(prev => ({ ...prev, connection_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableConnections.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formData.connection_type === 'network' && (
              <div className="grid grid-cols-2 gap-4 p-3 bg-muted/50 rounded-lg border">
                <div className="space-y-2">
                  <Label>IP Address</Label>
                  <Input
                    placeholder="192.168.1.100"
                    value={(formData.connection_params?.ipAddress as string) || ''}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      connection_params: { ...prev.connection_params, ipAddress: e.target.value },
                    }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Port</Label>
                  <Input
                    type="number"
                    placeholder="9100"
                    value={
                      formData.connection_params?.port == null
                        ? ''
                        : String(formData.connection_params.port)
                    }
                    onChange={(e) => {
                      const raw = e.target.value;
                      const parsed = raw === '' ? undefined : parseInt(raw, 10);
                      setFormData(prev => ({
                        ...prev,
                        connection_params: {
                          ...prev.connection_params,
                          port: Number.isFinite(parsed as number) ? parsed : undefined,
                        },
                      }));
                    }}
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDevice(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!editingDevice || !formData.device_role || !formData.driver_type) {
                  toast.error("Please select a device role and driver");
                  return;
                }
                if (formData.connection_type === 'network') {
                  const ip = (formData.connection_params?.ipAddress as string | undefined)?.trim();
                  const port = formData.connection_params?.port as number | undefined;
                  if (!ip) {
                    toast.error("IP Address is required for a network printer");
                    return;
                  }
                  if (!port || !Number.isFinite(port) || port <= 0 || port > 65535) {
                    toast.error("A valid Port (1–65535) is required for a network printer");
                    return;
                  }
                }
                updateDevice.mutate({
                  id: editingDevice.id,
                  display_name: formData.display_name,
                  device_role: formData.device_role as DeviceRole,
                  driver_type: formData.driver_type as DriverType,
                  connection_type: formData.connection_type,
                  connection_params: formData.connection_params,
                }, {
                  onSuccess: () => {
                    setEditingDevice(null);
                    toast.success("Device updated successfully");
                  },
                });
              }}
              disabled={updateDevice.isPending}
            >
              {updateDevice.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
