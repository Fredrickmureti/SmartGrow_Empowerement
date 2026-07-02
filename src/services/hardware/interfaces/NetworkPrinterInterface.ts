/**
 * Network Printer Interface — Discovery for network-connected printers.
 *
 * In Odoo, PrinterInterface uses Zeroconf/mDNS + CUPS.
 * In the browser, we:
 * 1. In Electron: scan the local subnet for open port 9100
 * 2. In Browser: use the IoT Box client agent to probe addresses
 * 3. Accept manually provided IPs and verify connectivity
 */

import { HardwareInterface, type DiscoveredDevice } from './InterfaceBase';
// Track H1 — isElectron import removed; probe path no longer branches on Electron
import { agentClient as iotBoxClient } from '../local-agent/AgentClient';

const THERMAL_PRINTER_PORT = 9100;

export class NetworkPrinterInterface extends HardwareInterface {
  readonly interfaceName = 'NetworkPrinterInterface';
  readonly connectionType = 'network' as const;

  private monitoredAddresses: Array<{ ip: string; port: number; name?: string }> = [];

  constructor() {
    super();
    this.pollingIntervalMs = 15000;
  }

  addMonitoredAddress(ip: string, port: number = THERMAL_PRINTER_PORT, name?: string): void {
    if (!this.monitoredAddresses.find(a => a.ip === ip && a.port === port)) {
      this.monitoredAddresses.push({ ip, port, name });
    }
  }

  removeMonitoredAddress(ip: string, port?: number): void {
    this.monitoredAddresses = this.monitoredAddresses.filter(
      a => !(a.ip === ip && (!port || a.port === port))
    );
  }

  async detectDevices(): Promise<DiscoveredDevice[]> {
    const devices: DiscoveredDevice[] = [];

    for (const addr of this.monitoredAddresses) {
      const reachable = await this.probeAddress(addr.ip, addr.port);
      if (reachable) {
        devices.push({
          identifier: `network:${addr.ip}:${addr.port}`,
          name: addr.name || `Network Printer (${addr.ip})`,
          connectionType: 'network',
          ipAddress: addr.ip,
          port: addr.port,
        });
      }
    }

    return devices;
  }

  async probeAddress(ip: string, port: number = THERMAL_PRINTER_PORT): Promise<boolean> {
    // Track H1 — direct `electronAPI.networkPrinter` probe removed. In
    // Electron, network-printer reachability is asserted by the
    // main-process `NetworkTransport` on first send (CommandRouter path).
    // Browser/non-Electron: probe via the local IoT-Box agent.
    if (iotBoxClient.isAvailable()) {
      const result = await iotBoxClient.testConnection(ip, port);
      return result.success;
    }
    return false;
  }

  async scanSubnet(subnetPrefix: string, port: number = THERMAL_PRINTER_PORT): Promise<DiscoveredDevice[]> {
    const devices: DiscoveredDevice[] = [];
    const ips = Array.from({ length: 254 }, (_, i) => `${subnetPrefix}.${i + 1}`);

    for (let i = 0; i < ips.length; i += 10) {
      const batch = ips.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (ip) => {
          const reachable = await this.probeAddress(ip, port);
          return reachable ? ip : null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const ip = result.value;
          devices.push({
            identifier: `network:${ip}:${port}`,
            name: `Network Printer (${ip})`,
            connectionType: 'network',
            ipAddress: ip,
            port,
          });
        }
      }
    }

    return devices;
  }
}
