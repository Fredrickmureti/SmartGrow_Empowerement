/**
 * Device classifier — vid/pid + name → (role, driver, confidence).
 *
 * Audit Wave 9d.8 (P2 #10). The renderer-side `matchDriverForDevice`
 * already exists for the browser path; this module is the main-process
 * mirror so the Electron discovery pipeline can suggest bindings
 * directly from a `pos:hardware:discover` IPC without round-tripping
 * through the renderer's DriverRegistry.
 *
 * Signature table is intentionally small but real (sourced from each
 * vendor's USB vendor-id allocation: Epson 0x04b8, Star 0x0519, Zebra
 * 0x0a5f, Bixolon 0x1504, Citizen 0x1d90, Honeywell 0x0c2e, Datalogic
 * 0x05f9, Mettler 0x0eb8). Confidence scoring lets the wizard rank
 * candidates when multiple drivers claim the same device.
 */

export type DeviceRoleSuggestion =
  | 'receipt_printer'
  | 'kitchen_printer'
  | 'label_printer'
  | 'cash_drawer'
  | 'scale'
  | 'barcode_scanner';

export interface ClassifiedCandidate {
  source: 'usb' | 'network' | 'serial';
  identifier: string;          // stable id for binding (e.g. "usb:04b8:0202")
  suggestedRole: DeviceRoleSuggestion;
  suggestedDriver: string;     // matches DriverRegistry keys (renderer side)
  confidence: number;          // 0..100
  label: string;               // human-readable, e.g. "Epson TM-T88 receipt printer"
  evidence: string;            // why we picked this
  raw: Record<string, unknown>;
}

interface UsbSignature {
  vid: number;
  pid?: number;                // omit to match any pid for this vendor
  role: DeviceRoleSuggestion;
  driver: string;
  confidence: number;
  label: string;
}

const USB_SIGNATURES: UsbSignature[] = [
  // Epson thermal receipt printers (TM-T88, TM-T20, TM-T82 …)
  { vid: 0x04b8, pid: 0x0202, role: 'receipt_printer', driver: 'epson', confidence: 95, label: 'Epson TM-T88 (ESC/POS)' },
  { vid: 0x04b8, pid: 0x0e15, role: 'receipt_printer', driver: 'epson', confidence: 95, label: 'Epson TM-T20 (ESC/POS)' },
  { vid: 0x04b8,             role: 'receipt_printer', driver: 'epson', confidence: 70, label: 'Epson thermal printer (ESC/POS)' },
  // Star Micronics
  { vid: 0x0519, role: 'receipt_printer', driver: 'star', confidence: 85, label: 'Star Micronics thermal printer (ESC/POS)' },
  // Bixolon
  { vid: 0x1504, role: 'receipt_printer', driver: 'bixolon', confidence: 85, label: 'Bixolon thermal printer (ESC/POS)' },
  // Citizen
  { vid: 0x1d90, role: 'receipt_printer', driver: 'citizen', confidence: 85, label: 'Citizen thermal printer (ESC/POS)' },
  // Zebra — label printers, default to ZPL
  { vid: 0x0a5f, role: 'label_printer', driver: 'zpl_label', confidence: 90, label: 'Zebra label printer (ZPL)' },
  // SATO label printers (commonly EPL-compatible in legacy mode)
  { vid: 0x1c1a, role: 'label_printer', driver: 'epl_label', confidence: 75, label: 'SATO label printer (EPL)' },
  // Honeywell / Metrologic scanners
  { vid: 0x0c2e, role: 'barcode_scanner', driver: 'hid_scanner', confidence: 90, label: 'Honeywell barcode scanner (HID)' },
  // Datalogic scanners
  { vid: 0x05f9, role: 'barcode_scanner', driver: 'hid_scanner', confidence: 90, label: 'Datalogic barcode scanner (HID)' },
  // Symbol/Zebra scanners
  { vid: 0x05e0, role: 'barcode_scanner', driver: 'hid_scanner', confidence: 90, label: 'Symbol/Zebra barcode scanner (HID)' },
  // Mettler scales
  { vid: 0x0eb8, role: 'scale', driver: 'mettler_scale', confidence: 90, label: 'Mettler scale' },
];

function nameHints(name: string): { role?: DeviceRoleSuggestion; driver?: string; boost: number } {
  const n = name.toLowerCase();
  if (n.includes('zebra') || n.includes('zpl')) return { role: 'label_printer', driver: 'zpl_label', boost: 20 };
  if (n.includes('eltron') || n.includes('epl')) return { role: 'label_printer', driver: 'epl_label', boost: 20 };
  if (n.includes('label')) return { role: 'label_printer', driver: 'escpos_label', boost: 10 };
  if (n.includes('kitchen')) return { role: 'kitchen_printer', driver: 'epson', boost: 15 };
  if (n.includes('receipt') || n.includes('thermal') || n.includes('pos-')) return { role: 'receipt_printer', driver: 'escpos', boost: 10 };
  if (n.includes('scanner') || n.includes('barcode')) return { role: 'barcode_scanner', driver: 'hid_scanner', boost: 20 };
  if (n.includes('scale')) return { role: 'scale', driver: 'generic_scale', boost: 15 };
  if (n.includes('drawer')) return { role: 'cash_drawer', driver: 'escpos_drawer', boost: 20 };
  // Wave 11 R11: was mis-mapping VFD/customer-display USBs to `receipt_printer`.
  if (n.includes('display') || n.includes('vfd') || n.includes('customer')) return { role: 'customer_display', driver: 'line_display', boost: 15 };

  return { boost: 0 };
}

export function classifyUsb(d: { vendorId: number; productId: number; manufacturer?: string | null; product?: string | null }): ClassifiedCandidate | null {
  // First, exact (vid,pid); then vendor-only.
  const exact = USB_SIGNATURES.find((s) => s.vid === d.vendorId && s.pid === d.productId);
  const vendor = USB_SIGNATURES.find((s) => s.vid === d.vendorId && s.pid === undefined);
  const base = exact ?? vendor;
  const hint = nameHints(`${d.manufacturer ?? ''} ${d.product ?? ''}`);

  if (!base && !hint.role) return null;

  const role = (base?.role ?? hint.role) as DeviceRoleSuggestion;
  const driver = base?.driver ?? hint.driver ?? 'escpos';
  const confidence = Math.min(99, (base?.confidence ?? 30) + hint.boost);
  const label = base?.label ?? `${d.manufacturer ?? 'Unknown'} ${d.product ?? ''}`.trim();
  const evidence = [
    exact ? `vid/pid match (${exact.label})` : null,
    !exact && vendor ? `vendor match (${vendor.label})` : null,
    hint.role ? `name hint "${(d.product ?? d.manufacturer ?? '').toLowerCase()}"` : null,
  ].filter(Boolean).join('; ');

  return {
    source: 'usb',
    identifier: `usb:${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`,
    suggestedRole: role,
    suggestedDriver: driver,
    confidence,
    label,
    evidence: evidence || 'fallback default',
    raw: { vendorId: d.vendorId, productId: d.productId, manufacturer: d.manufacturer, product: d.product },
  };
}

export function classifyNetwork(host: string, port: number, service?: string | null, txt?: Record<string, string>): ClassifiedCandidate {
  // mDNS service type carries the strongest signal.
  const svc = (service ?? '').toLowerCase();
  let role: DeviceRoleSuggestion = 'receipt_printer';
  let driver = 'escpos';
  let confidence = 60;
  let label = `Network printer ${host}:${port}`;
  let evidence = `tcp probe ${host}:${port}`;
  if (svc.includes('ipp')) { confidence = 80; evidence = `mDNS service ${svc}`; }
  if (svc.includes('pdl-datastream')) { confidence = 85; evidence = `mDNS PDL datastream`; }
  if (svc.includes('escpos')) { confidence = 95; driver = 'escpos'; evidence = `mDNS _escpos._tcp advertisement`; }
  if (txt) {
    const ty = (txt.ty ?? txt.product ?? '').toLowerCase();
    if (ty.includes('zebra') || ty.includes('zpl')) { role = 'label_printer'; driver = 'zpl_label'; confidence = 90; label = `Zebra ${ty}`; }
    if (ty.includes('epson')) { driver = 'epson'; label = `Epson ${ty}`; confidence = 85; }
    if (ty.includes('star')) { driver = 'star'; label = `Star ${ty}`; confidence = 85; }
  }
  return {
    source: 'network',
    identifier: `net:${host}:${port}`,
    suggestedRole: role,
    suggestedDriver: driver,
    confidence,
    label,
    evidence,
    raw: { host, port, service, txt },
  };
}
