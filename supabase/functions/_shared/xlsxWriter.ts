// @ts-nocheck — Deno runtime
/**
 * xlsxWriter — minimal, dependency-free .xlsx (Office Open XML) writer.
 *
 * Produces a single-sheet workbook from a column header list and 2D string
 * grid. Built specifically for `submission_format.type = 'gov_xlsx'` bulk
 * import files (KRA PAYE bulk template, SARS bulk forms, etc.).
 *
 * Only the parts of the OOXML spec that Excel / LibreOffice / KRA portals
 * actually need are emitted:
 *   - [Content_Types].xml
 *   - _rels/.rels
 *   - xl/workbook.xml + xl/_rels/workbook.xml.rels
 *   - xl/worksheets/sheet1.xml
 *
 * Numbers are emitted as <c t="n"><v>…</v></c>; everything else as inline
 * strings (<c t="inlineStr"><is><t>…</t></is></c>) to avoid the shared-
 * strings table. Result is a deflate-zipped file readable by every spreadsheet
 * client we've tested, and small enough (typically < 100 KB even for
 * year-end runs) that the slight wire-size overhead is irrelevant.
 *
 * No npm dependency: ZIP is produced with Deno's std `compress/deflate`.
 */
// pako ships a stable `deflateRaw` in every runtime we deploy to.
// Deno's std no longer re-exports it from `io/mod.ts` (breaks edge boot).
import pako from "npm:pako@2.1.0";
const deflateRaw = (data: Uint8Array): Uint8Array => pako.deflateRaw(data);

// ---------- ZIP (stored + deflate) ----------------------------------------

// CRC-32 table
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function le16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function le32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

interface ZipEntry { name: string; data: Uint8Array; }

async function buildZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const enc = new TextEncoder();
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const uncomp = e.data.length;
    // Try deflate; fall back to stored if it actually grows the bytes.
    let compMethod = 8;
    let compBytes: Uint8Array;
    try {
      compBytes = await deflateRaw(e.data);
      if (compBytes.length >= uncomp) { compBytes = e.data; compMethod = 0; }
    } catch {
      compBytes = e.data; compMethod = 0;
    }
    const compSize = compBytes.length;

    // Local file header
    const lfh = concat([
      le32(0x04034b50),       // signature
      le16(20),                // version needed
      le16(0),                 // flags
      le16(compMethod),        // method
      le16(0), le16(0),        // mod time / date
      le32(crc),               // CRC-32
      le32(compSize),          // compressed size
      le32(uncomp),            // uncompressed size
      le16(nameBytes.length),  // file name length
      le16(0),                 // extra length
      nameBytes,
      compBytes,
    ]);
    local.push(lfh);

    // Central directory header
    const cdh = concat([
      le32(0x02014b50),
      le16(20), le16(20),
      le16(0), le16(compMethod),
      le16(0), le16(0),
      le32(crc),
      le32(compSize), le32(uncomp),
      le16(nameBytes.length),
      le16(0), le16(0),
      le16(0), le16(0),
      le32(0),
      le32(offset),
      nameBytes,
    ]);
    central.push(cdh);
    offset += lfh.length;
  }

  const localBlob = concat(local);
  const centralBlob = concat(central);
  const end = concat([
    le32(0x06054b50),
    le16(0), le16(0),
    le16(entries.length), le16(entries.length),
    le32(centralBlob.length),
    le32(localBlob.length),
    le16(0),
  ]);
  return concat([localBlob, centralBlob, end]);
}

// ---------- OOXML helpers --------------------------------------------------

function xmlEscape(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Excel column letter from 1-indexed column number
function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null | undefined>>;
}

export async function writeXlsx(sheet: XlsxSheet): Promise<Uint8Array> {
  const enc = new TextEncoder();

  // sheet1.xml
  const sheetRows: string[] = [];
  // header row
  const headerCells = sheet.headers.map((h, i) =>
    `<c r="${colLetter(i + 1)}1" t="inlineStr"><is><t>${xmlEscape(h)}</t></is></c>`,
  ).join("");
  sheetRows.push(`<row r="1">${headerCells}</row>`);
  // data rows
  sheet.rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = row.map((v, i) => {
      const ref = `${colLetter(i + 1)}${r}`;
      if (v === null || v === undefined || v === "") return `<c r="${ref}"/>`;
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" t="n"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
    }).join("");
    sheetRows.push(`<row r="${r}">${cells}</row>`);
  });
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  return await buildZip([
    { name: "[Content_Types].xml",         data: enc.encode(contentTypes) },
    { name: "_rels/.rels",                 data: enc.encode(rootRels) },
    { name: "xl/workbook.xml",             data: enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels",  data: enc.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml",    data: enc.encode(sheetXml) },
  ]);
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
