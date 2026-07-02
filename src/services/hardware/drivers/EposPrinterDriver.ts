/**
 * ePOS Printer Driver — Epson ePOS SDK HTTP/XML protocol.
 *
 * This implements Odoo's "direct LAN" pattern for supported Epson printers.
 * The browser sends HTTP/HTTPS requests directly to the printer's ePOS endpoint.
 * No edge function, no local agent needed — just standard HTTP.
 *
 * Supported printers: Epson TM series with network interface + ePOS firmware.
 * Requires: Printer on same network, static IP, HTTPS certificate (or HTTP).
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, PrintCommand, DeviceInfo,
} from './DriverInterface';

export class EposPrinterDriver implements IDriver {
  readonly driverType: DriverType = 'epos_printer';
  readonly supportedRoles: DeviceRole[] = ['receipt_printer', 'kitchen_printer'];
  readonly supportedBackends: ConnectionBackend[] = ['browser', 'network'];

  private _status: DeviceStatus = { connected: false, status: 'unknown' };
  private _ipAddress = '';
  private _port = 443;
  private _useSsl = true;
  private _deviceId = 'local_printer'; // ePOS device ID (usually 'local_printer')

  supported(deviceInfo: DeviceInfo): number {
    // Match Epson ePOS-capable printers
    if (deviceInfo.connectionType === 'epos' || deviceInfo.connectionType === 'epos_http') return 12;
    if (deviceInfo.manufacturer?.toLowerCase().includes('epson') && deviceInfo.connectionType === 'network') return 6;
    return 0;
  }

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    this._ipAddress = params.ipAddress as string;
    this._port = (params.port as number) || (params.useSsl ? 443 : 8008);
    this._useSsl = params.useSsl !== false;
    this._deviceId = (params.eposDeviceId as string) || 'local_printer';

    if (!this._ipAddress) {
      this._status = { connected: false, status: 'error', lastError: 'IP address required' };
      return { success: false, error: 'IP address is required for ePOS printer' };
    }

    // Test the ePOS endpoint
    const reachable = await this.testConnection();
    if (reachable) {
      this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
      return { success: true };
    }

    this._status = { connected: false, status: 'error', lastError: 'ePOS endpoint unreachable' };
    return { success: false, error: `Cannot reach ePOS endpoint at ${this._getBaseUrl()}` };
  }

  async disconnect(): Promise<DriverResult> {
    this._status = { connected: false, status: 'offline' };
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return { ...this._status };
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'print_receipt') {
      return this._printReceipt(command as PrintCommand);
    }

    if (command.type === 'open_drawer') {
      return this._openDrawer();
    }

    return { success: false, error: `Unsupported ePOS command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      // Probe the ePOS service endpoint
      const res = await fetch(this._getServiceUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: this._buildStatusRequest(),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // ePOS returns 200 even for errors — check XML response
      if (res.ok) {
        this._status.lastSeenAt = new Date().toISOString();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──

  private _getBaseUrl(): string {
    const protocol = this._useSsl ? 'https' : 'http';
    return `${protocol}://${this._ipAddress}:${this._port}`;
  }

  private _getServiceUrl(): string {
    return `${this._getBaseUrl()}/cgi-bin/epos/service.cgi?devid=${this._deviceId}&timeout=10000`;
  }

  /** Build ePOS XML for a receipt print job */
  private async _printReceipt(cmd: PrintCommand): Promise<DriverResult> {
    const lines = cmd.payload.lines || [];
    let xml = '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">';

    // Header
    if (cmd.payload.header) {
      xml += '<text align="center" em="true"/>';
      for (const h of cmd.payload.header) {
        xml += `<text>${this._escapeXml(h.text)}&#10;</text>`;
      }
      xml += '<text em="false"/>';
      xml += '<feed line="1"/>';
    }

    // Body lines
    for (const line of lines) {
      const align = line.align || 'left';
      const bold = line.bold ? ' em="true"' : '';
      const dw = line.doubleWidth ? ' dw="true"' : '';
      const dh = line.doubleHeight ? ' dh="true"' : '';
      xml += `<text align="${align}"${bold}${dw}${dh}>${this._escapeXml(line.text)}&#10;</text>`;
      // Reset after formatting
      if (line.bold || line.doubleWidth || line.doubleHeight) {
        xml += '<text em="false" dw="false" dh="false"/>';
      }
    }

    // Footer
    if (cmd.payload.footer) {
      xml += '<feed line="1"/>';
      xml += '<text align="center"/>';
      for (const f of cmd.payload.footer) {
        xml += `<text>${this._escapeXml(f.text)}&#10;</text>`;
      }
    }

    // Cut
    if (cmd.payload.cut !== false) {
      xml += '<feed line="4"/>';
      xml += '<cut type="feed"/>';
    }

    // Open drawer
    if (cmd.payload.openDrawer) {
      xml += '<pulse drawer="drawer_1" time="pulse_100"/>';
    }

    xml += '</epos-print>';

    return this._sendEposXml(xml);
  }

  /** Open cash drawer via ePOS */
  private async _openDrawer(): Promise<DriverResult> {
    const xml = `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
      <pulse drawer="drawer_1" time="pulse_100"/>
    </epos-print>`;
    return this._sendEposXml(xml);
  }

  /** Send ePOS XML to the printer */
  private async _sendEposXml(xmlBody: string): Promise<DriverResult> {
    const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>${xmlBody}</s:Body>
</s:Envelope>`;

    try {
      const res = await fetch(this._getServiceUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': '""',
        },
        body: soapEnvelope,
      });

      if (!res.ok) {
        return { success: false, error: `ePOS HTTP ${res.status}: ${res.statusText}` };
      }

      const responseText = await res.text();
      // Check for success in ePOS response XML
      if (responseText.includes('success="true"') || responseText.includes('code="SUCCESS"')) {
        this._status = { connected: true, status: 'online', lastSeenAt: new Date().toISOString() };
        return { success: true };
      }

      // Extract error code
      const codeMatch = responseText.match(/code="([^"]+)"/);
      const errorCode = codeMatch?.[1] || 'UNKNOWN_ERROR';
      return { success: false, error: `ePOS error: ${errorCode}` };
    } catch (err) {
      this._status = { connected: false, status: 'error', lastError: (err as Error).message };
      return { success: false, error: `ePOS request failed: ${(err as Error).message}` };
    }
  }

  /** Build a status-check XML request */
  private _buildStatusRequest(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">
    </epos-print>
  </s:Body>
</s:Envelope>`;
  }

  private _escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
