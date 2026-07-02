/**
 * Shared ESC/POS Command Constants
 * 
 * Single source of truth for all ESC/POS byte sequences.
 * Used by PrinterService, NetworkPrinterService, and all printer drivers.
 * Eliminates the duplicated CMD / ESC_POS_CMD constants.
 */

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

export const ESCPOS = {
  /** Initialize printer — resets formatting to defaults */
  INIT: [ESC, 0x40],

  // ── Alignment ──
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],

  // ── Text formatting ──
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  UNDERLINE_ON: [ESC, 0x2d, 0x01],
  UNDERLINE_OFF: [ESC, 0x2d, 0x00],

  // ── Character size ──
  DOUBLE_WIDTH_ON: [GS, 0x21, 0x10],
  DOUBLE_HEIGHT_ON: [GS, 0x21, 0x01],
  DOUBLE_ON: [GS, 0x21, 0x11],
  DOUBLE_OFF: [GS, 0x21, 0x00],

  // ── Paper control ──
  CUT_PAPER: [GS, 0x56, 0x00],
  CUT_PARTIAL: [GS, 0x56, 0x01],
  LINE_FEED: [LF],
  FEED_LINES: (n: number): number[] => [ESC, 0x64, n],

  // ── Cash drawer ──
  OPEN_DRAWER_PIN2: [ESC, 0x70, 0x00, 0x19, 0xfa],
  OPEN_DRAWER_PIN5: [ESC, 0x70, 0x01, 0x19, 0xfa],

  // ── Barcode ──
  BARCODE_HEIGHT: (h: number): number[] => [GS, 0x68, h],
  BARCODE_WIDTH: (w: number): number[] => [GS, 0x77, w],
  BARCODE_HRI_BELOW: [GS, 0x48, 0x02],
  BARCODE_EAN13: (data: string): number[] => [GS, 0x6b, 0x02, ...new TextEncoder().encode(data), 0x00],
  BARCODE_CODE128: (data: string): number[] => [GS, 0x6b, 0x49, data.length, ...new TextEncoder().encode(data)],

  // ── QR Code ──
  QR_MODEL: [GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00],
  QR_SIZE: (s: number): number[] => [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, s],
  QR_ERROR_CORRECTION_L: [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30],

  // ── Status request ──
  STATUS_REQUEST: [0x10, 0x04, 0x01],
};

/** Known thermal printer USB vendor IDs */
export const KNOWN_PRINTER_VENDORS: Record<number, string> = {
  0x04b8: 'Epson',
  0x0519: 'Star Micronics',
  0x0dd4: 'Custom',
  0x0fe6: 'Bixolon',
  0x1504: 'Citizen',
  0x0416: 'Winbond (generic)',
  0x0483: 'STMicroelectronics (many thermal printers)',
  0x1fc9: 'NXP (some POS printers)',
  0x20d1: 'Sewoo',
  0x0525: 'Netchip (USB-to-parallel)',
};

/** Known scale USB vendor IDs */
export const KNOWN_SCALE_VENDORS: Record<number, string> = {
  0x0b67: 'Mettler-Toledo',
  0x0922: 'Dymo / USPS scales',
  0x1446: 'CAS',
  0x0eb8: 'Fairbanks',
};

/** Known barcode scanner USB vendor IDs */
export const KNOWN_SCANNER_VENDORS: Record<number, string> = {
  0x05e0: 'Symbol / Zebra',
  0x0c2e: 'Metrologic / Honeywell',
  0x040b: 'Datalogic',
  0x04b4: 'Cypress (many HID scanners)',
};
