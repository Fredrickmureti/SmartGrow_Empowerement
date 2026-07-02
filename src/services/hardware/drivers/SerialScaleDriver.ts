/**
 * Serial Scale Driver
 *
 * Communicates with weighing scales via Web Serial API or through
 * the IoT Box agent. Supports Toledo, CAS, and generic protocols.
 *
 * Architecture:
 * - Owns its own serial connection (Web Serial API) or delegates
 *   to the IoT Box agent for remote serial access
 * - Does NOT delegate to the legacy ScaleService singleton
 * - Manages weight readings internally with subscriber pattern
 *
 * Supported protocols:
 * - Toledo: STX + 6-digit weight + unit (e.g., "W001500KG")
 * - CAS: "ST,GS,+00000.000kg" format
 * - Generic: any numeric value followed by optional unit
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, DeviceInfo,
} from './DriverInterface';
import { KNOWN_SCALE_VENDORS } from '../escpos-commands';

type ScaleProtocol = 'toledo' | 'cas' | 'generic';

export interface WeightReading {
  weight: number;
  unit: 'kg' | 'lb' | 'g' | 'oz';
  stable: boolean;
  timestamp: string;
}

// ── Protocol parsers ──

const PROTOCOL_PARSERS: Record<ScaleProtocol, (data: string) => WeightReading | null> = {
  toledo(data: string): WeightReading | null {
    const match = data.match(/^.{1}(\d{6})(KG|LB|G|OZ)/i);
    if (match) {
      return {
        weight: parseFloat(match[1]) / 1000,
        unit: match[2].toLowerCase() as WeightReading['unit'],
        stable: true,
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  },

  cas(data: string): WeightReading | null {
    const match = data.match(/([+-]?\d+\.?\d*)\s*(kg|lb|g|oz)/i);
    if (match) {
      return {
        weight: parseFloat(match[1]),
        unit: match[2].toLowerCase() as WeightReading['unit'],
        stable: data.includes('ST'),
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  },

  generic(data: string): WeightReading | null {
    const match = data.match(/(\d+\.?\d*)\s*(kg|lb|g|oz)?/i);
    if (match) {
      return {
        weight: parseFloat(match[1]),
        unit: (match[2]?.toLowerCase() as WeightReading['unit']) || 'kg',
        stable: true,
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  },
};

/** Tare commands by protocol */
const TARE_COMMANDS: Record<ScaleProtocol, string> = {
  toledo: 'T\r\n',
  cas: 'Z\r\n',
  generic: 'T\r\n',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNavigatorSerial = (): any => (navigator as any).serial;

export class SerialScaleDriver implements IDriver {
  readonly driverType: DriverType;
  readonly supportedRoles: DeviceRole[] = ['scale'];
  readonly supportedBackends: ConnectionBackend[] = ['electron', 'webserial', 'browser'];

  private protocol: ScaleProtocol;
  private _status: DeviceStatus = { connected: false, status: 'unknown' };
  private _lastReading: WeightReading | null = null;
  private _subscribers = new Set<(reading: WeightReading) => void>();

  // Web Serial state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _serialPort: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _reader: any = null;
  private _readingActive = false;

  constructor(protocol: ScaleProtocol = 'generic') {
    this.protocol = protocol;
    this.driverType = `${protocol}_scale` as DriverType;
    if (!['toledo_scale', 'cas_scale', 'generic_scale'].includes(this.driverType)) {
      this.driverType = 'generic_scale' as DriverType;
    }
  }

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.vendorId && KNOWN_SCALE_VENDORS[deviceInfo.vendorId]) return 10;
    if (deviceInfo.connectionType === 'serial') return 3;
    return 0;
  }

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    const connectionType = (params.connection_type as string) || 'browser';

    // Browser simulation mode
    if (connectionType === 'browser') {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    }

    // Serial connection via Web Serial API
    if (connectionType === 'serial') {
      return this._connectSerial(params);
    }

    this._status = { connected: false, status: 'error', lastError: `Unsupported connection: ${connectionType}` };
    return { success: false, error: `Scale connection type not supported: ${connectionType}` };
  }

  async disconnect(): Promise<DriverResult> {
    this._readingActive = false;
    this._subscribers.clear();

    if (this._reader) {
      try { await this._reader.cancel(); } catch { /* ignore */ }
      this._reader = null;
    }

    if (this._serialPort) {
      try { await this._serialPort.close(); } catch { /* ignore */ }
      this._serialPort = null;
    }

    this._status = { connected: false, status: 'offline' };
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return { ...this._status };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'read_weight') {
      return { success: !!this._lastReading, data: this._lastReading };
    }

    if (command.type === 'tare') {
      return this._tare();
    }

    if (command.type === 'simulate_weight') {
      const payload = command.payload as { weight: number; unit?: string };
      this._simulateWeight(payload.weight, (payload.unit as WeightReading['unit']) || 'kg');
      return { success: true };
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    if (!this._serialPort) {
      // Browser simulation mode — check status flag
      return this._status.connected;
    }
    return this._serialPort?.readable !== undefined;
  }

  // ═══════════════════════════════════════════
  //  Web Serial connection
  // ═══════════════════════════════════════════

  private async _connectSerial(params: Record<string, unknown>): Promise<DriverResult> {
    const serial = getNavigatorSerial();
    if (!serial) {
      this._status = { connected: false, status: 'error', lastError: 'Web Serial API not supported' };
      return { success: false, error: 'Web Serial API not supported in this browser' };
    }

    try {
      const ports = await serial.getPorts();
      let port = ports[0];
      if (!port) {
        port = await serial.requestPort();
      }

      const baudRate = (params.baudRate as number) || 9600;
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });

      this._serialPort = port;
      this._startReading();
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    } catch (error) {
      const message = (error as Error).message;
      this._status = { connected: false, status: 'error', lastError: message };
      return { success: false, error: message };
    }
  }

  // ═══════════════════════════════════════════
  //  Serial reading loop
  // ═══════════════════════════════════════════

  private async _startReading(): Promise<void> {
    if (!this._serialPort?.readable) return;

    this._readingActive = true;
    const textDecoder = new TextDecoderStream();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._serialPort.readable.pipeTo(textDecoder.writable as any);
    this._reader = textDecoder.readable.getReader();

    let buffer = '';
    try {
      while (this._readingActive) {
        const { value, done } = await this._reader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split(/[\r\n]+/);
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            this._processReading(line);
          }
        }
      }
    } catch (error) {
      if (this._readingActive) {
        console.error('[SerialScaleDriver] Read error:', error);
        this._status = { connected: false, status: 'error', lastError: 'Serial read error' };
      }
    }
  }

  private _processReading(data: string): void {
    const parser = PROTOCOL_PARSERS[this.protocol] || PROTOCOL_PARSERS.generic;
    const reading = parser(data);
    if (reading) {
      this._lastReading = reading;
      for (const cb of this._subscribers) {
        try { cb(reading); } catch { /* ignore subscriber errors */ }
      }
    }
  }

  // ═══════════════════════════════════════════
  //  Tare
  // ═══════════════════════════════════════════

  private async _tare(): Promise<DriverResult> {
    if (!this._serialPort?.writable) {
      return { success: false, error: 'Scale not connected or not writable' };
    }

    const command = TARE_COMMANDS[this.protocol] || TARE_COMMANDS.generic;
    try {
      const writer = this._serialPort.writable.getWriter();
      await writer.write(new TextEncoder().encode(command));
      writer.releaseLock();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ═══════════════════════════════════════════
  //  Simulation (browser mode)
  // ═══════════════════════════════════════════

  private _simulateWeight(weight: number, unit: WeightReading['unit']): void {
    const reading: WeightReading = {
      weight,
      unit,
      stable: true,
      timestamp: new Date().toISOString(),
    };
    this._lastReading = reading;
    for (const cb of this._subscribers) {
      try { cb(reading); } catch { /* ignore */ }
    }
  }
}
