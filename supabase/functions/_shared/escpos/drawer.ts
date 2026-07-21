/**
 * Cash-drawer audit-slip ESC/POS builder — Phase B1 (ADR-0085 owner).
 *
 * Enterprise POS (Oracle Xstore, NCR CounterPoint, Aloha) prints an
 * audit slip every time the physical cash drawer is opened outside a
 * completed sale — cash_in/cash_out, safe-drops, bank deposits, petty
 * cash, corrections, manager no-sale. Auditors treat the slip as the
 * SOX / PCI evidence that the open was authorized: cashier, time,
 * amount, reason, and (optionally) a manager override id.
 *
 * Pure function — no IO. Deterministic output for golden tests.
 * ASCII-only encoding matches the discipline in `kitchen.ts`.
 */

export type DrawerSlipWidth = "40mm" | "58mm" | "80mm";

const COLS: Record<DrawerSlipWidth, number> = { "40mm": 24, "58mm": 32, "80mm": 48 };

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CMD = {
  INIT: [ESC, 0x40],
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  DOUBLE_ON: [GS, 0x21, 0x11],
  DOUBLE_OFF: [GS, 0x21, 0x00],
  CUT_FULL: [GS, 0x56, 0x00],
  CUT_PARTIAL: [GS, 0x56, 0x01],
  FEED: (n: number) => [ESC, 0x64, n],
};

export interface DrawerSlipData {
  /** Human-readable movement kind: "CASH IN", "SAFE DROP", "NO SALE", … */
  movement_label: string;
  /** Signed amount in the register's currency. Positive = drawer gained cash. */
  amount: number | null;
  /** ISO currency code, e.g. "KES". Optional. */
  currency?: string | null;
  /** Movement wall-clock time. */
  performed_at: string | Date;
  /** Free-form reason (audit narrative). */
  reason?: string | null;
  /** Coded reason (dropdown selection). */
  reason_code?: string | null;
  /** Additional operator notes. */
  notes?: string | null;
  /** Business / store name printed as header. */
  business_name?: string | null;
  /** Register / terminal identifier. */
  register_name?: string | null;
  /** Cashier who performed the open. */
  cashier_name?: string | null;
  /** Shift number the slip is bound to (for reconciliation). */
  shift_number?: string | null;
  /** Manager override id when the movement crossed an approval threshold. */
  manager_override_id?: string | null;
  /** Movement id — printed so a paper slip can be matched back to the row. */
  movement_id?: string | null;
}

export interface DrawerSlipOptions {
  width?: DrawerSlipWidth;
  cut?: "full" | "partial" | "none";
  feedLines?: number;
}

const ASCII_TRANSLIT: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",
  "‘": "'", "’": "'", "‚": ",",
  "“": '"', "”": '"', "„": '"',
  "…": "...",
  "•": "*", "·": ".",
  "°": "deg",
};

function toAscii(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) { out += ch; continue; }
    if (code === 0x0a) { out += ch; continue; }
    if (ASCII_TRANSLIT[ch] !== undefined) { out += ASCII_TRANSLIT[ch]; continue; }
    out += "?";
  }
  return out;
}

function pushBytes(buf: number[], bytes: readonly number[]): void {
  for (const b of bytes) buf.push(b);
}

function pushAscii(buf: number[], text: string): void {
  const ascii = toAscii(text);
  for (let i = 0; i < ascii.length; i++) buf.push(ascii.charCodeAt(i) & 0xff);
}

function pushLine(buf: number[], text = ""): void {
  pushAscii(buf, text);
  buf.push(LF);
}

function fmtAmount(amount: number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "-";
  const abs = Math.abs(Number(amount)).toFixed(2);
  const sign = Number(amount) < 0 ? "-" : "";
  return `${currency ? currency + " " : ""}${sign}${abs}`;
}

function fmtTime(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function keyVal(buf: number[], cols: number, key: string, val: string): void {
  const k = toAscii(key);
  const v = toAscii(val);
  const gap = cols - k.length - v.length;
  if (gap < 1) {
    pushLine(buf, k);
    pushLine(buf, v);
    return;
  }
  pushLine(buf, k + " ".repeat(gap) + v);
}

function wrapAndPush(buf: number[], cols: number, prefix: string, text: string): void {
  const ascii = toAscii(text);
  const first = prefix + ascii;
  if (first.length <= cols) { pushLine(buf, first); return; }
  pushLine(buf, first.slice(0, cols));
  let rest = first.slice(cols);
  const indent = " ".repeat(Math.min(prefix.length, cols - 1));
  while (rest.length > 0) {
    const line = indent + rest.slice(0, cols - indent.length);
    pushLine(buf, line);
    rest = rest.slice(cols - indent.length);
  }
}

export function buildDrawerSlipEscPos(
  data: DrawerSlipData,
  opts: DrawerSlipOptions = {},
): Uint8Array {
  const width: DrawerSlipWidth = opts.width ?? "80mm";
  const cols = COLS[width];
  const cut = opts.cut ?? "full";
  const feedLines = Math.max(0, Math.min(10, opts.feedLines ?? 4));

  const buf: number[] = [];
  pushBytes(buf, CMD.INIT);

  // Banner
  pushBytes(buf, CMD.ALIGN_CENTER);
  pushBytes(buf, CMD.BOLD_ON);
  pushBytes(buf, CMD.DOUBLE_ON);
  pushLine(buf, "DRAWER SLIP".slice(0, Math.max(1, Math.floor(cols / 2))));
  pushBytes(buf, CMD.DOUBLE_OFF);
  pushLine(buf, (data.movement_label || "OPEN").toUpperCase().slice(0, cols));
  pushBytes(buf, CMD.BOLD_OFF);

  if (data.business_name) {
    pushLine(buf, toAscii(data.business_name).slice(0, cols));
  }

  pushBytes(buf, CMD.ALIGN_LEFT);
  pushLine(buf, "-".repeat(cols));

  // Meta block — every enterprise slip carries these five fields
  keyVal(buf, cols, "Time:", fmtTime(data.performed_at));
  if (data.register_name) keyVal(buf, cols, "Register:", data.register_name);
  if (data.shift_number)  keyVal(buf, cols, "Shift:", data.shift_number);
  if (data.cashier_name)  keyVal(buf, cols, "Cashier:", data.cashier_name);

  pushLine(buf, "-".repeat(cols));

  // Amount (emphasised — this is the audit-critical field)
  pushBytes(buf, CMD.BOLD_ON);
  keyVal(buf, cols, "Amount:", fmtAmount(data.amount, data.currency));
  pushBytes(buf, CMD.BOLD_OFF);

  if (data.reason_code) keyVal(buf, cols, "Code:", data.reason_code);
  if (data.reason)      wrapAndPush(buf, cols, "Reason: ", data.reason);
  if (data.notes)       wrapAndPush(buf, cols, "Notes:  ", data.notes);

  if (data.manager_override_id) {
    pushLine(buf, "-".repeat(cols));
    wrapAndPush(buf, cols, "Mgr Override: ", data.manager_override_id);
  }

  if (data.movement_id) {
    pushLine(buf, "-".repeat(cols));
    wrapAndPush(buf, cols, "Ref: ", data.movement_id);
  }

  pushLine(buf, "-".repeat(cols));

  // Signature line — auditors sign the paper slip, not the screen.
  pushLine(buf, "Signature: ______________________".slice(0, cols));

  pushBytes(buf, CMD.FEED(feedLines));
  if (cut === "full")       pushBytes(buf, CMD.CUT_FULL);
  else if (cut === "partial") pushBytes(buf, CMD.CUT_PARTIAL);

  return new Uint8Array(buf);
}
