/**
 * Kitchen-ticket ESC/POS builder — Wave 10 (audit P3 #16).
 *
 * Kitchen tickets are NOT receipts. They intentionally drop totals,
 * payments, tax, fiscal blocks, branding, and currency — the cook does
 * not need a tax breakdown. What the line cook DOES need is:
 *
 *   - A big, unmistakable banner ("KITCHEN" or the station name) so the
 *     ticket can't be confused with a customer receipt mid-rush.
 *   - The order/transaction number and a wall-clock time, so the
 *     expediter can sequence orders.
 *   - Table / customer / register identifier so the runner knows where
 *     it goes.
 *   - The items, with quantity on the LEFT (cooks scan quantities
 *     first), bold + double-wide line name, then any modifier/notes
 *     indented under the item.
 *   - A clean cut at the end.
 *
 * This module is deliberately self-contained — it does NOT import the
 * receipt engine. Receipt logic (currency, fiscal blocks, payments,
 * section ordering) has no business path through the kitchen.
 *
 * Output: a `Uint8Array` of raw ESC/POS bytes. ASCII-only encoding;
 * any non-ASCII characters are transliterated to ASCII or replaced with
 * '?'. This matches the discipline of the ZPL builder and is enforced
 * by the golden test in `src/test/printing/kitchen-ticket-golden.test.ts`.
 */

export type KitchenWidth = "40mm" | "58mm" | "80mm";

const COLS: Record<KitchenWidth, number> = { "40mm": 24, "58mm": 32, "80mm": 48 };

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const CMD = {
  INIT: [ESC, 0x40],
  ALIGN_LEFT: [ESC, 0x61, 0x00],
  ALIGN_CENTER: [ESC, 0x61, 0x01],
  BOLD_ON: [ESC, 0x45, 0x01],
  BOLD_OFF: [ESC, 0x45, 0x00],
  DOUBLE_ON: [GS, 0x21, 0x11], // double width + height
  DOUBLE_OFF: [GS, 0x21, 0x00],
  CUT_FULL: [GS, 0x56, 0x00],
  CUT_PARTIAL: [GS, 0x56, 0x01],
  FEED: (n: number) => [ESC, 0x64, n],
};

export interface KitchenTicketItem {
  /** Item name as it should print. */
  description: string;
  /** Quantity. Non-positive values are normalized to 1. */
  quantity: number;
  /** Optional list of modifiers / "no onions" / "extra cheese" lines. */
  modifiers?: readonly string[];
  /** Optional per-item note from the cashier. */
  notes?: string | null;
}

export interface KitchenTicketData {
  /** Order / transaction number printed in the meta block. */
  order_number: string;
  /** When the order was placed. ISO string or Date. */
  placed_at: string | Date;
  /** Optional station label printed as the banner. Default "KITCHEN". */
  station?: string | null;
  /** Optional course label (e.g. "STARTERS"). */
  course?: string | null;
  /** Optional table identifier — "Table 7" / "Bar 2". */
  table?: string | null;
  /** Optional customer name (takeaway, called-in). */
  customer_name?: string | null;
  /** Optional register/POS terminal that fired the ticket. */
  register_name?: string | null;
  /** Optional cashier name. */
  cashier_name?: string | null;
  items: readonly KitchenTicketItem[];
}

export interface KitchenBuildOptions {
  width?: KitchenWidth;
  /** Cut at end. Default "full" when the printer supports it. */
  cut?: "full" | "partial" | "none";
  /** Lines to feed before the cut. Default 4 — gives the cutter clearance. */
  feedLines?: number;
}

const ASCII_TRANSLIT: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",
  "‘": "'", "’": "'", "‚": ",", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "…": "...",
  "•": "*", "·": ".",
  "→": "->", "←": "<-", "↔": "<->",
  "°": "deg",
};

function toAscii(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    }
    if (code === 0x0a) {
      out += ch;
      continue;
    }
    if (ASCII_TRANSLIT[ch] !== undefined) {
      out += ASCII_TRANSLIT[ch];
      continue;
    }
    // Last resort: replace with '?'. Never silently drop a glyph.
    out += "?";
  }
  return out;
}

function pushBytes(buf: number[], bytes: readonly number[]): void {
  for (const b of bytes) buf.push(b);
}

function pushAscii(buf: number[], text: string): void {
  const ascii = toAscii(text);
  for (let i = 0; i < ascii.length; i++) {
    buf.push(ascii.charCodeAt(i) & 0xff);
  }
}

function pushLine(buf: number[], text = ""): void {
  pushAscii(buf, text);
  buf.push(LF);
}

function wrap(text: string, cols: number): string[] {
  const ascii = toAscii(text);
  if (ascii.length <= cols) return [ascii];
  const out: string[] = [];
  const words = ascii.split(/\s+/);
  let line = "";
  for (const w of words) {
    if (!line.length) {
      // Hard-break overlong tokens.
      if (w.length > cols) {
        for (let i = 0; i < w.length; i += cols) out.push(w.slice(i, i + cols));
        continue;
      }
      line = w;
      continue;
    }
    if (line.length + 1 + w.length <= cols) {
      line += " " + w;
    } else {
      out.push(line);
      if (w.length > cols) {
        for (let i = 0; i < w.length; i += cols) out.push(w.slice(i, i + cols));
        line = "";
      } else {
        line = w;
      }
    }
  }
  if (line.length) out.push(line);
  return out;
}

function formatPlacedAt(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return String(value);
  // Local-ish 24h: "YYYY-MM-DD HH:MM". The kitchen does not need seconds.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Build the ESC/POS byte stream for one kitchen ticket.
 *
 * Pure function — no IO, no environment access. The output is fully
 * determined by `(data, opts)` so the golden test can lock the bytes.
 */
export function buildKitchenTicketEscPos(
  data: KitchenTicketData,
  opts: KitchenBuildOptions = {},
): Uint8Array {
  const width: KitchenWidth = opts.width ?? "80mm";
  const cols = COLS[width];
  const cut = opts.cut ?? "full";
  const feedLines = Math.max(0, Math.min(10, opts.feedLines ?? 4));

  const buf: number[] = [];

  pushBytes(buf, CMD.INIT);

  // ── Banner ────────────────────────────────────────────────────────────
  pushBytes(buf, CMD.ALIGN_CENTER);
  pushBytes(buf, CMD.BOLD_ON);
  pushBytes(buf, CMD.DOUBLE_ON);
  const banner = (data.station && data.station.trim().length > 0)
    ? data.station.trim().toUpperCase()
    : "KITCHEN";
  // The banner is printed double-wide, so the effective column budget
  // halves. Hard-clip rather than wrap — the banner should be one line.
  const bannerCols = Math.max(1, Math.floor(cols / 2));
  pushLine(buf, banner.slice(0, bannerCols));
  pushBytes(buf, CMD.DOUBLE_OFF);
  pushBytes(buf, CMD.BOLD_OFF);

  if (data.course && data.course.trim().length > 0) {
    pushBytes(buf, CMD.BOLD_ON);
    pushLine(buf, data.course.trim().toUpperCase().slice(0, cols));
    pushBytes(buf, CMD.BOLD_OFF);
  }

  // ── Meta block (left aligned) ─────────────────────────────────────────
  pushBytes(buf, CMD.ALIGN_LEFT);
  pushLine(buf, "-".repeat(cols));
  pushLine(buf, `Order: ${data.order_number}`);
  pushLine(buf, `Time:  ${formatPlacedAt(data.placed_at)}`);
  if (data.table) pushLine(buf, `Table: ${data.table}`);
  if (data.customer_name) {
    for (const line of wrap(`Cust:  ${data.customer_name}`, cols)) pushLine(buf, line);
  }
  if (data.register_name) pushLine(buf, `Reg:   ${data.register_name}`);
  if (data.cashier_name) pushLine(buf, `By:    ${data.cashier_name}`);
  pushLine(buf, "-".repeat(cols));

  // ── Items ─────────────────────────────────────────────────────────────
  // Quantity is the most-scanned field. Print it bold + double-wide on
  // the line head, then the item name. Modifiers and notes are indented
  // two spaces under each item.
  if (data.items.length === 0) {
    pushBytes(buf, CMD.BOLD_ON);
    pushLine(buf, "(no items)");
    pushBytes(buf, CMD.BOLD_OFF);
  } else {
    for (const item of data.items) {
      const qty = Number.isFinite(item.quantity) && item.quantity > 0
        ? Math.floor(item.quantity)
        : 1;
      const qtyTag = `${qty}x `;
      // Wrap the item name into the remaining column budget; continuation
      // lines are indented under the name.
      const nameCols = Math.max(1, cols - qtyTag.length);
      const wrapped = wrap(item.description ?? "", nameCols);

      pushBytes(buf, CMD.BOLD_ON);
      pushLine(buf, qtyTag + (wrapped[0] ?? ""));
      pushBytes(buf, CMD.BOLD_OFF);
      for (let i = 1; i < wrapped.length; i++) {
        pushLine(buf, " ".repeat(qtyTag.length) + wrapped[i]);
      }

      const mods = item.modifiers ?? [];
      for (const mod of mods) {
        for (const line of wrap(`  - ${mod}`, cols)) pushLine(buf, line);
      }
      if (item.notes && item.notes.trim().length > 0) {
        for (const line of wrap(`  * ${item.notes.trim()}`, cols)) pushLine(buf, line);
      }
    }
  }

  pushLine(buf, "-".repeat(cols));

  // ── Feed + cut ────────────────────────────────────────────────────────
  if (feedLines > 0) pushBytes(buf, CMD.FEED(feedLines));
  if (cut === "full") pushBytes(buf, CMD.CUT_FULL);
  else if (cut === "partial") pushBytes(buf, CMD.CUT_PARTIAL);

  return Uint8Array.from(buf);
}
