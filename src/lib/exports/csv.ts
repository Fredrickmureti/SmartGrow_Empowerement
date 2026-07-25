/**
 * Canonical client-side CSV export writer.
 *
 * This is the SINGLE owner of `text/csv` bytes emitted from the browser
 * bundle. Every module (Payroll, HR, Finance, Inventory, Procurement,
 * Sales, POS, Contacts, Reports, Audit Logs, Banking, Fixed Assets, …)
 * MUST route CSV downloads through this file. Mirrors the server-side
 * contract in `supabase/functions/_shared/exports/reportCsv.ts` and
 * `statementCsv.ts` so client- and server-emitted CSVs are byte-shape
 * identical.
 *
 * Guarantees (RFC 4180 + Excel-safe):
 *   • UTF-8 with BOM (\uFEFF) — makes Excel on Windows open the file
 *     as UTF-8 instead of falling back to the OS ANSI codepage
 *     (CP1252/CP936). Without this, non-ASCII characters render as
 *     gibberish ("Chinese" on CJK Windows locales).
 *   • CRLF row separator — required by RFC 4180 §2.1 and by Excel for
 *     reliable multi-line cell handling on macOS.
 *   • `"` → `""` escaping, and quote wrapping whenever a cell contains
 *     `,` `;` `"` `\r` `\n` or leading/trailing whitespace.
 *   • Numbers formatted with `.` decimal separator (no thousands sep).
 *   • Booleans → "Yes" / "No".
 *   • Date objects → `YYYY-MM-DD` ISO date.
 *   • null / undefined → empty cell.
 *
 * Ownership guardrails: `no-raw-csv-blob` ESLint rule + arch test
 * enforce that no other file constructs a `text/csv` Blob directly.
 */

const CRLF = "\r\n";
const BOM = "\uFEFF";

export type CsvBuildOptions = {
  /** Field delimiter. Default `,`. `;` for EU-locale Excel. */
  delimiter?: "," | ";" | "\t";
  /** End-of-line. Default `\r\n` (RFC 4180). */
  eol?: "\r\n" | "\n";
  /** Prepend UTF-8 BOM. Default `true` — required for Excel. */
  bom?: boolean;
};

export type CsvColumn<T = Record<string, unknown>> = {
  key: keyof T & string;
  header: string;
  /** Optional per-cell formatter. Returns any primitive; falsy/nullish → "". */
  format?: (value: unknown, row: T) => string | number | boolean | null | undefined;
};

/** Escape a single cell value for RFC 4180 output. */
function csvCell(value: unknown, delimiter: string): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) {
    // ISO date only — matches server reportCsv convention.
    s = Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  } else if (typeof value === "boolean") {
    s = value ? "Yes" : "No";
  } else if (typeof value === "number") {
    s = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "object") {
    // Never let a raw object serialize as "[object Object]".
    try { s = JSON.stringify(value); } catch { s = String(value); }
  } else {
    s = String(value);
  }
  const mustQuote =
    s.includes(delimiter) ||
    s.includes('"') ||
    s.includes("\r") ||
    s.includes("\n") ||
    /^\s|\s$/.test(s);
  return mustQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build a CSV byte payload from rows.
 *
 * Two calling shapes:
 *   • `buildCsv(rows, columns)` where columns is `CsvColumn<T>[]` —
 *     structured, formatter-aware.
 *   • `buildCsv(rows, headers)` where headers is `string[]` — object
 *     keys must match; useful for quick migrations.
 *
 * Also accepts an already-formed 2D `string[][]` of rows in the low-
 * level `buildCsvFromMatrix` helper below.
 */
export function buildCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: CsvColumn<T>[] | string[],
  opts: CsvBuildOptions = {},
): Uint8Array {
  const delimiter = opts.delimiter ?? ",";
  const eol = opts.eol ?? CRLF;
  const bom = opts.bom !== false;

  const normalized: { header: string; get: (row: T) => unknown }[] =
    columns.length === 0
      ? []
      : typeof columns[0] === "string"
        ? (columns as string[]).map((k) => ({ header: k, get: (r) => r[k as keyof T] }))
        : (columns as CsvColumn<T>[]).map((c) => ({
            header: c.header,
            get: (r) => (c.format ? c.format(r[c.key], r) : r[c.key]),
          }));

  const lines: string[] = [];
  lines.push(normalized.map((c) => csvCell(c.header, delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(normalized.map((c) => csvCell(c.get(row), delimiter)).join(delimiter));
  }
  const body = (bom ? BOM : "") + lines.join(eol) + eol;
  return new TextEncoder().encode(body);
}

/**
 * Build CSV bytes from a pre-formed 2D matrix (first row = headers).
 * Use when the caller has already computed row cells but still needs
 * canonical encoding / BOM / CRLF.
 */
export function buildCsvFromMatrix(
  matrix: (string | number | boolean | null | undefined)[][],
  opts: CsvBuildOptions = {},
): Uint8Array {
  const delimiter = opts.delimiter ?? ",";
  const eol = opts.eol ?? CRLF;
  const bom = opts.bom !== false;
  const lines = matrix.map((row) => row.map((c) => csvCell(c, delimiter)).join(delimiter));
  const body = (bom ? BOM : "") + lines.join(eol) + eol;
  return new TextEncoder().encode(body);
}

/**
 * Wrap a caller-produced CSV string in canonical Excel-safe bytes.
 * Migration seam for existing sites that already build valid CSV text:
 * they just need BOM + Blob wrapping. Idempotent — if the input already
 * begins with U+FEFF it is not double-added.
 */
export function csvStringToBytes(csv: string, opts: CsvBuildOptions = {}): Uint8Array {
  const bom = opts.bom !== false;
  let out = csv;
  // Normalize bare LF row separators to CRLF unless caller opted into LF.
  if ((opts.eol ?? CRLF) === CRLF) {
    // Only rewrite standalone \n, preserve existing \r\n.
    out = out.replace(/\r?\n/g, CRLF);
  }
  if (bom && !out.startsWith(BOM)) out = BOM + out;
  return new TextEncoder().encode(out);
}

/** Build a canonical `text/csv; charset=utf-8` Blob. */
export function csvBlob(input: Uint8Array | string, opts: CsvBuildOptions = {}): Blob {
  const bytes = typeof input === "string" ? csvStringToBytes(input, opts) : input;
  // BlobPart typing accepts Uint8Array in every supported browser runtime.
  return new Blob([bytes as BlobPart], { type: "text/csv;charset=utf-8" });
}

function sanitizeFilename(name: string): string {
  const stripped = name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim();
  return stripped.length > 0 ? stripped : "export";
}

/**
 * Trigger a browser download for a CSV payload.
 *
 * @param filename  With or without a `.csv` extension — one will be appended if missing.
 * @param input     Uint8Array (from `buildCsv`), a pre-formed CSV string, or a Blob.
 */
export function downloadCsv(
  filename: string,
  input: Uint8Array | string | Blob,
  opts: CsvBuildOptions = {},
): void {
  const blob = input instanceof Blob ? input : csvBlob(input, opts);
  const safe = sanitizeFilename(filename);
  const finalName = /\.csv$/i.test(safe) ? safe : `${safe}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = finalName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Detach on the next tick so Firefox has time to start the download.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
