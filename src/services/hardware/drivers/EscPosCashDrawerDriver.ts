/**
 * ESC/POS Cash Drawer Driver
 *
 * Cash drawers are physically connected to receipt printers via RJ-11 port.
 * This driver sends ESC/POS kick-drawer commands through the transport layer.
 *
 * Architecture:
 * - Uses the same transport resolution as EscPosPrinterDriver (resolveTransport)
 * - Does NOT delegate to the legacy CashDrawerService singleton
 * - Owns its own connection state (no peeking at printerService)
 *
 * ESC/POS drawer commands:
 *   ESC p <pin> <on-time> <off-time>
 *   Pin 0 (connector pin 2): 0x1b 0x70 0x00 0x19 0x78
 *   Pin 1 (connector pin 5): 0x1b 0x70 0x01 0x19 0x78
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, OpenDrawerCommand, DeviceInfo,
} from './DriverInterface';
import { KNOWN_PRINTER_VENDORS } from '../escpos-commands';
import { resolveTransport, type ITransport, type ResolveTransportOptions } from '../transport';

/** ESC/POS drawer kick command bytes */
const DRAWER_COMMANDS = {
  /** Pin 2 (most common): ESC p 0 25 120 */
  pin2: [0x1b, 0x70, 0x00, 0x19, 0x78] as number[],
  /** Pin 5 (secondary drawer): ESC p 1 25 120 */
  pin5: [0x1b, 0x70, 0x01, 0x19, 0x78] as number[],
};

type DrawerStatus = 'open' | 'closed' | 'unknown';

export class EscPosCashDrawerDriver implements IDriver {
  readonly driverType: DriverType = 'escpos_drawer';
  readonly supportedRoles: DeviceRole[] = ['cash_drawer'];
  readonly supportedBackends: ConnectionBackend[] = ['electron', 'webusb', 'network', 'browser'];

  private _transport: ITransport | null = null;
  private _drawerStatus: DrawerStatus = 'unknown';
  private _status: DeviceStatus = { connected: false, status: 'unknown' };

  supported(deviceInfo: DeviceInfo): number {
    // Cash drawers are connected via printers — same vendor matching
    if (deviceInfo.vendorId && KNOWN_PRINTER_VENDORS[deviceInfo.vendorId]) return 5;
    if (deviceInfo.connectionType === 'usb' && deviceInfo.deviceClass === 7) return 5;
    if (deviceInfo.connectionType === 'browser') return 1;
    return 0;
  }

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    const connectionType = (params.connection_type as string) || 'browser';

    // Browser simulation mode — no transport needed
    if (connectionType === 'browser') {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    }

    // Resolve transport (same as printer — drawer uses the printer's physical connection)
    const transportOpts: ResolveTransportOptions = {
      transport: (params.transport as string | undefined) ?? connectionType ?? 'local_agent',
      ipAddress: params.ipAddress as string | undefined,
      port: params.port as number | undefined,
      vendorId: params.vendorId as number | undefined,
      productId: params.productId as number | undefined,
    };

    const transport = resolveTransport(transportOpts);
    if (!transport) {
      this._status = { connected: false, status: 'error', lastError: `No transport for ${connectionType}` };
      return { success: false, error: `No available transport for connection type: ${connectionType}` };
    }

    this._transport = transport;

    // Test the transport
    const testResult = await transport.test();
    if (testResult.success) {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    }

    this._status = { connected: false, status: 'error', lastError: testResult.error };
    return { success: false, error: testResult.error };
  }

  async disconnect(): Promise<DriverResult> {
    if (this._transport) {
      await this._transport.disconnect();
      this._transport = null;
    }
    this._status = { connected: false, status: 'offline' };
    this._drawerStatus = 'unknown';
    return { success: true };
  }

  getStatus(): DeviceStatus {
    if (this._transport && !this._transport.isAvailable() && this._status.connected) {
      this._status = {
        connected: false,
        status: 'offline',
        lastError: `Transport ${this._transport.name} no longer available`,
      };
    }
    return { ...this._status };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'open_drawer') {
      return this._openDrawer(command as OpenDrawerCommand);
    }

    if (command.type === 'get_drawer_status') {
      return { success: true, data: { drawerStatus: this._drawerStatus } };
    }

    if (command.type === 'confirm_closed') {
      this._drawerStatus = 'closed';
      return { success: true };
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    // Browser simulation is always "connected"
    if (!this._transport) return this._status.connected;

    const result = await this._transport.test();
    this._status.connected = result.success;
    this._status.status = result.success ? 'online' : 'offline';
    this._status.lastError = result.error;
    if (result.success) this._status.lastSeenAt = new Date().toISOString();
    return result.success;
  }

  // ═══════════════════════════════════════════
  //  Private — drawer kick logic
  // ═══════════════════════════════════════════

  private async _openDrawer(cmd: OpenDrawerCommand): Promise<DriverResult> {
    const pin = cmd.payload?.pin || 2;
    const bytes = pin === 5 ? DRAWER_COMMANDS.pin5 : DRAWER_COMMANDS.pin2;

    // Browser simulation
    if (!this._transport) {
      if (this._status.connected) {
        console.log(`[EscPosCashDrawerDriver] Cash drawer opened (browser simulation, pin ${pin})`);
        this._drawerStatus = 'open';
        return { success: true, data: { pin, simulated: true } };
      }
      return { success: false, error: 'Not connected — no transport available' };
    }

    try {
      const result = await this._transport.send(bytes);
      if (result.success) {
        this._drawerStatus = 'open';
      }
      return { success: result.success, error: result.error, data: { pin } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}
