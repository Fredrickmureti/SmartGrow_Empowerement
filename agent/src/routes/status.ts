import { getUptime } from '../server.js';
import { handleDiscover } from './discover.js';
import { loadUsbRuntime } from '../usb-runtime.js';
import { getRelayHealth, type RelayHealth } from '../relay-state.js';

interface DeviceInfo {
  type: 'network' | 'usb' | 'serial';
  identifier: string;
  name?: string;
  ipAddress?: string;
  port?: number;
  vendorId?: number;
  productId?: number;
}

interface AgentStatusResponse {
  running: boolean;
  version: string;
  devices: DeviceInfo[];
  uptime: number;
  /**
   * Relay liveness. `state: 'ok'` is the only value that means jobs queued
   * from an HTTPS browser will actually be picked up by this workstation.
   */
  relay: RelayHealth;
}

// Cached discovered devices — refreshed periodically
let cachedDevices: DeviceInfo[] = [];
let lastDiscoveryTime = 0;
const DISCOVERY_INTERVAL_MS = 120_000; // re-scan every 2 minutes

/**
 * Run device discovery in the background and cache results.
 * Non-blocking — failures are silently ignored.
 */
export async function refreshDeviceDiscovery(): Promise<void> {
  try {
    const result = await handleDiscover('auto');
    const networkDevices: DeviceInfo[] = result.devices.map(d => ({
      type: 'network' as const,
      identifier: d.identifier,
      name: d.name,
      ipAddress: d.ipAddress,
      port: d.port,
    }));

    // Try to add USB devices if the usb module is available
    let usbDevices: DeviceInfo[] = [];
    try {
      const usbModule = await loadUsbRuntime();
      const list: any[] = usbModule ? usbModule.getDeviceList() : [];
      usbDevices = list.map((d: any) => ({
        type: 'usb' as const,
        identifier: `${d.deviceDescriptor.idVendor.toString(16)}:${d.deviceDescriptor.idProduct.toString(16)}`,
        vendorId: d.deviceDescriptor.idVendor,
        productId: d.deviceDescriptor.idProduct,
      }));
    } catch {
      // USB module not available — skip
    }

    cachedDevices = [...networkDevices, ...usbDevices];
    lastDiscoveryTime = Date.now();
    console.log(`[agent] Discovery complete: ${cachedDevices.length} device(s) found`);
  } catch (err) {
    console.error('[agent] Discovery failed:', err);
  }
}

/**
 * Start periodic background discovery.
 * Called once on agent startup from index.ts.
 */
export function startPeriodicDiscovery(): void {
  // Initial discovery (non-blocking)
  refreshDeviceDiscovery();
  setInterval(() => {
    refreshDeviceDiscovery();
  }, DISCOVERY_INTERVAL_MS);
}

export function handleStatus(): AgentStatusResponse {
  return {
    running: true,
    version: '1.3.0-edge.p3',
    devices: cachedDevices,
    uptime: getUptime(),
    relay: getRelayHealth(),
  };
}
