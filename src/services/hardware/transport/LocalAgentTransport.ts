/**
 * Local Agent Transport — HTTP client for our local IoT Box agent.
 *
 * The local agent runs on the same machine (or LAN) as the browser.
 * It bridges the browser to USB/network printers via raw TCP/USB.
 *
 * This is the Odoo "IoT Box" equivalent for our system.
 *
 * For network printers: browser → agent HTTP → agent TCP → printer
 * For USB printers:     browser → agent HTTP → agent USB → printer
 */

import type { ITransport, TransportResult, NetworkTarget, USBTarget } from './TransportAdapter';
import { agentClient as iotBoxClient } from '../local-agent/AgentClient';

/**
 * Routes print data to a network printer via the local agent.
 */
export class LocalAgentNetworkTransport implements ITransport {
  readonly name = 'LocalAgentNetwork';
  private target: NetworkTarget;
  private _lastDeepProbeAt = 0;
  private _lastDeepProbeOk = true;
  private _lastDeepProbeError: string | undefined;
  /** Minimum interval between real TCP probes against the printer. */
  private static readonly DEEP_PROBE_INTERVAL_MS = 120_000;

  constructor(target: NetworkTarget) {
    this.target = target;
  }

  isAvailable(): boolean {
    return iotBoxClient.isAvailable();
  }

  async send(data: number[] | Uint8Array): Promise<TransportResult> {
    const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
    const result = await iotBoxClient.printNetwork(
      this.target.ipAddress,
      this.target.port,
      dataArray,
    );
    // A real send is the most authoritative signal — refresh the deep-probe cache.
    if (result.success) {
      this._lastDeepProbeOk = true;
      this._lastDeepProbeError = undefined;
      this._lastDeepProbeAt = Date.now();
    }
    return {
      success: result.success,
      error: result.error
        ? `[Agent ${iotBoxClient.getBaseUrl()} → ${this.target.ipAddress}:${this.target.port}] ${result.error}`
        : undefined,
      bytesWritten: result.bytesWritten,
    };
  }

  async test(): Promise<TransportResult> {
    // Cheap path: if the agent is reachable AND we've seen the printer recently,
    // don't slam the printer's TCP socket on every health tick. Only probe deep
    // every DEEP_PROBE_INTERVAL_MS or when the previous probe failed.
    const agentUp = iotBoxClient.isAvailable();
    if (!agentUp) {
      return {
        success: false,
        error: `[Agent ${iotBoxClient.getBaseUrl()}] local print agent unreachable`,
      };
    }

    const now = Date.now();
    const stale = now - this._lastDeepProbeAt > LocalAgentNetworkTransport.DEEP_PROBE_INTERVAL_MS;
    if (!stale && this._lastDeepProbeOk) {
      return { success: true };
    }

    const result = await iotBoxClient.testConnection(this.target.ipAddress, this.target.port);
    this._lastDeepProbeAt = now;
    this._lastDeepProbeOk = result.success;
    this._lastDeepProbeError = result.error;
    return {
      success: result.success,
      error: result.error
        ? `[Agent ${iotBoxClient.getBaseUrl()} → ${this.target.ipAddress}:${this.target.port}] ${result.error}`
        : undefined,
    };
  }

  async disconnect(): Promise<void> {
    // Agent transports are stateless per-request — nothing to disconnect
  }
}

/**
 * Routes print data to a USB printer via the local agent.
 */
export class LocalAgentUSBTransport implements ITransport {
  readonly name = 'LocalAgentUSB';
  private target: USBTarget;

  constructor(target: USBTarget) {
    this.target = target;
  }

  isAvailable(): boolean {
    return iotBoxClient.isAvailable();
  }

  async send(data: number[] | Uint8Array): Promise<TransportResult> {
    const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
    const result = await iotBoxClient.printUsb(
      this.target.vendorId,
      this.target.productId,
      dataArray,
    );
    return { success: result.success, error: result.error };
  }

  async test(): Promise<TransportResult> {
    // Test USB by sending ESC/POS init
    return this.send([0x1b, 0x40]);
  }

  async disconnect(): Promise<void> {
    // Stateless
  }
}
