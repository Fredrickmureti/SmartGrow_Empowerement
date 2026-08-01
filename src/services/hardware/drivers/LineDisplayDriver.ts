/**
 * Line Display Driver — VFD/LCD customer-facing line display (browser only).
 *
 * Speaks standard ESC/POS display commands (Epson DM-D, Bixolon BCD and
 * compatibles) over the Web Serial API.
 *
 * Electron installs do NOT use this driver: the registry marks `line_display`
 * as `browserFallback`, so desktop routes to the main-process display driver
 * over the serial transport owned by the device runtime. This class therefore
 * carries no Electron branch at all — one transport, no shadow path.
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

export class LineDisplayDriver implements IDriver {
  readonly driverType: DriverType = 'line_display';
  readonly supportedRoles: DeviceRole[] = ['customer_display'];
  readonly supportedBackends: ConnectionBackend[] = ['webserial'];

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
      if (!('serial' in navigator)) {
        this.lastError = 'This browser has no Web Serial support for line displays.';
        return { success: false, error: this.lastError };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nav = navigator as any;
      const port = await nav.serial.requestPort();
      await port.open({ baudRate });
      this.serialPort = port;
      this.writer = port.writable.getWriter();


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
    if (!this.writer) return;
    await this.writer.write(new Uint8Array(bytes));
  }

  private async sendString(text: string): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(new TextEncoder().encode(text));
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
