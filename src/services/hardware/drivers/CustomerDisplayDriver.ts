/**
 * Customer Display Driver
 * Wraps existing CustomerDisplayService with driver abstraction.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DisplayUpdateCommand, DeviceInfo,
} from './DriverInterface';
import { customerDisplayClient as customerDisplayService } from '../local-display/CustomerDisplayClient';

export class CustomerDisplayDriver implements IDriver {
  readonly driverType: DriverType = 'secondary_screen_display';
  readonly supportedRoles: DeviceRole[] = ['customer_display'];
  readonly supportedBackends: ConnectionBackend[] = ['electron', 'browser'];

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.connectionType === 'browser') return 3;
    return 0;
  }

  private _status: DeviceStatus = { connected: false, status: 'unknown' };

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    const result = await customerDisplayService.open({
      enabled: true,
      displayIndex: (params.displayIndex as number) ?? 1,
      fullscreen: (params.fullscreen as boolean) ?? true,
    });

    if (result.success) {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
    } else {
      this._status = { connected: false, status: 'error', lastError: result.error };
    }

    return result;
  }

  async disconnect(): Promise<DriverResult> {
    const result = await customerDisplayService.close();
    this._status = { connected: false, status: 'offline' };
    return result;
  }

  getStatus(): DeviceStatus {
    this._status.connected = customerDisplayService.isDisplayConnected();
    this._status.status = this._status.connected ? 'online' : 'offline';
    return this._status;
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'update_display') {
      const cmd = command as DisplayUpdateCommand;
      return customerDisplayService.update({
        status: cmd.payload.status,
        items: cmd.payload.items.map((i) => ({ id: '', ...i })),
        subtotal: cmd.payload.subtotal,
        tax: cmd.payload.tax,
        discount: cmd.payload.discount,
        total: cmd.payload.total,
        message: cmd.payload.message,
        customerName: cmd.payload.customerName,
      });
    }

    if (command.type === 'show_message') {
      const payload = command.payload as { message: string; status?: string };
      return customerDisplayService.showMessage(
        payload.message,
        payload.status as 'idle' | 'scanning' | 'payment' | 'complete'
      );
    }

    if (command.type === 'reset_display') {
      return customerDisplayService.reset();
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    return customerDisplayService.isDisplayConnected();
  }
}
