/**
 * Line Display Driver — VFD/LCD customer-facing line display.
 * 
 * Communicates via serial (RS-232 or USB-serial) to 2-line or 4-line
 * customer-facing pole displays. Uses standard ESC/POS display commands
 * common to Epson DM-D, Bixolon BCD, and compatible displays.
 * 
 * Connection params:
 *   - baudRate: serial baud rate (default 9600)
 *   - columns: number of character columns (default 20)
 *   - rows: number of rows (default 2)
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { isElectron } from '@/lib/environment';

// Track H4 — the renderer-side `ElectronBridge.connectSerialPort` shell was
// deleted. In Electron, serial line displays should be wired into the
// main-process device runtime (CommandRouter + a serial transport). Until
// that driver migration lands, the Electron branch here returns an explicit
// error so callers get a clear signal instead of a silent half-success.
const electronBridgeDead = {
  connectSerialPort: async (_path: string, _baud: number) => ({
    success: false as const,
    error: 'LineDisplayDriver: Electron serial bridge removed in Track H4. Configure the customer display through the main-process device manager.',
  }),
  disconnectSerialPort: async () => ({ success: true as const }),
  writeToSerialPort: async (_data: string) => { /* no-op */ },
};
const electronBridge = electronBridgeDead;

export class LineDisplayDriver implements IDriver {
  readonly driverType: DriverType = 'line_display';
  readonly supportedRoles: DeviceRole[] = ['customer_display'];
  readonly supportedBackends: ConnectionBackend[] = ['electron', 'webserial'];

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.connectionType === 'serial') return 5;
    return 0;
  }

  private connected = false;
  private columns = 20;
  private rows = 2;
  private lastError: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serialPort: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private writer: any = null;

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    const baudRate = (params.baudRate as number) || 9600;
    this.columns = (params.columns as number) || 20;
    this.rows = (params.rows as number) || 2;

    try {
      if (isElectron()) {
        const portPath = params.portPath as string;
        if (!portPath) {
          return { success: false, error: 'Serial port path required for Electron' };
        }
        const result = await electronBridge.connectSerialPort(portPath, baudRate);
        if (!result.success) {
          this.lastError = result.error;
          return { success: false, error: result.error };
        }
      } else if ('serial' in navigator) {
        // Web Serial API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nav = navigator as any;
        const port = await nav.serial.requestPort();
        await port.open({ baudRate });
        this.serialPort = port;
        this.writer = port.writable.getWriter();
      } else {
        return { success: false, error: 'No serial port API available' };
      }

      this.connected = true;
      this.lastError = undefined;

      // Initialize display: clear and set to overwrite mode
      await this.sendCommand([0x1B, 0x40]); // Initialize
      await this.sendCommand([0x0C]);        // Clear display

      console.log('[LineDisplay] Connected');
      return { success: true };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { success: false, error: this.lastError };
    }
  }

  async disconnect(): Promise<DriverResult> {
    try {
      // Clear display before disconnecting
      if (this.connected) {
        await this.sendCommand([0x0C]);
      }

      if (this.writer) {
        await this.writer.releaseLock();
        this.writer = null;
      }
      if (this.serialPort?.readable) {
        await this.serialPort.close();
        this.serialPort = null;
      }
      if (isElectron()) {
        await electronBridge.disconnectSerialPort();
      }
    } catch {
      // ignore cleanup errors
    }

    this.connected = false;
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return {
      connected: this.connected,
      status: this.connected ? 'online' : 'offline',
      lastError: this.lastError,
      capabilities: [`${this.columns}x${this.rows}`],
    };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (!this.connected) {
      return { success: false, error: 'Display not connected' };
    }

    switch (command.type) {
      case 'update_display': {
        const payload = command.payload as {
          total?: number;
          message?: string;
          items?: Array<{ name: string; price: number }>;
          status?: string;
        };
        return this.updateDisplay(payload);
      }
      case 'clear_display':
        await this.sendCommand([0x0C]);
        return { success: true };
      case 'show_text': {
        const { line1, line2 } = command.payload as { line1?: string; line2?: string };
        return this.showText(line1, line2);
      }
      default:
        return { success: false, error: `Unknown command: ${command.type}` };
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.connected) return false;
    try {
      await this.sendCommand([0x1B, 0x76]); // Status request
      return true;
    } catch {
      return false;
    }
  }

  private async updateDisplay(payload: {
    total?: number;
    message?: string;
    items?: Array<{ name: string; price: number }>;
    status?: string;
  }): Promise<DriverResult> {
    try {
      await this.sendCommand([0x0C]); // Clear

      if (payload.status === 'idle' || payload.status === 'complete') {
        const msg = payload.message || 'Welcome!';
        await this.showText(
          this.centerText(msg),
          payload.total != null ? this.rightAlign(`Total: ${payload.total.toFixed(2)}`) : undefined,
        );
      } else if (payload.items?.length) {
        const lastItem = payload.items[payload.items.length - 1];
        await this.showText(
          this.truncate(lastItem.name),
          this.rightAlign(lastItem.price.toFixed(2)),
        );
      } else if (payload.total != null) {
        await this.showText(
          'TOTAL:',
          this.rightAlign(payload.total.toFixed(2)),
        );
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  private async showText(line1?: string, line2?: string): Promise<DriverResult> {
    try {
      // Move cursor to line 1
      await this.sendCommand([0x1B, 0x6C, 0x01, 0x01]);
      if (line1) {
        await this.sendString(this.truncate(line1));
      }

      if (this.rows >= 2 && line2) {
        // Move cursor to line 2
        await this.sendCommand([0x1B, 0x6C, 0x01, 0x02]);
        await this.sendString(this.truncate(line2));
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  private async sendCommand(bytes: number[]): Promise<void> {
    const data = new Uint8Array(bytes);
    if (this.writer) {
      await this.writer.write(data);
    } else if (isElectron()) {
      await electronBridge.writeToSerialPort(String.fromCharCode(...bytes));
    }
  }

  private async sendString(text: string): Promise<void> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    if (this.writer) {
      await this.writer.write(data);
    } else if (isElectron()) {
      await electronBridge.writeToSerialPort(text);
    }
  }

  private truncate(text: string): string {
    return text.length > this.columns ? text.substring(0, this.columns) : text;
  }

  private centerText(text: string): string {
    const trimmed = this.truncate(text);
    const pad = Math.max(0, Math.floor((this.columns - trimmed.length) / 2));
    return ' '.repeat(pad) + trimmed;
  }

  private rightAlign(text: string): string {
    const trimmed = this.truncate(text);
    const pad = Math.max(0, this.columns - trimmed.length);
    return ' '.repeat(pad) + trimmed;
  }
}
