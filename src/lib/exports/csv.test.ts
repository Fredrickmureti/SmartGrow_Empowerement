/**
 * Unit tests for the canonical client-side CSV writer.
 * Guarantees the file opens correctly in Excel/Numbers/Sheets without
 * a manual "import as UTF-8" step.
 */
import { describe, it, expect } from "vitest";
import { buildCsv, buildCsvFromMatrix, csvStringToBytes } from "./csv";

const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

describe("buildCsv", () => {
  it("emits a UTF-8 BOM as the first bytes", () => {
    const bytes = buildCsv([{ a: 1 }], ["a"]);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
  });

  it("uses CRLF between rows and terminates with CRLF", () => {
    const text = decode(buildCsv([{ a: "x" }, { a: "y" }], ["a"]));
    // BOM + "a\r\nx\r\ny\r\n"
    expect(text).toBe("\uFEFFa\r\nx\r\ny\r\n");
  });

  it("quotes and escapes commas, quotes, newlines and edge whitespace", () => {
    const text = decode(buildCsv(
      [{ v: 'he said "hi", then\nleft' }, { v: " leading" }, { v: "trailing " }],
      ["v"],
    ));
    expect(text).toContain('"he said ""hi"", then\r\nleft"');
    expect(text).toContain('" leading"');
    expect(text).toContain('"trailing "');
  });

  it("round-trips non-ASCII characters (é, ñ, €, 中文, ش)", () => {
    const bytes = buildCsv([{ v: "café — €5 中文 ش" }], ["v"]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text).toContain("café — €5 中文 ش");
  });

  it("renders null/undefined as empty cells and booleans as Yes/No", () => {
    const text = decode(buildCsv(
      [{ a: null, b: undefined, c: true, d: false }],
      ["a", "b", "c", "d"],
    ));
    expect(text.split("\r\n")[1]).toBe(",,Yes,No");
  });

  it("supports custom delimiter and disables BOM when asked", () => {
    const bytes = buildCsv([{ a: 1, b: 2 }], ["a", "b"], { delimiter: ";", bom: false });
    const text = decode(bytes);
    expect(text.startsWith("\uFEFF")).toBe(false);
    expect(text).toBe("a;b\r\n1;2\r\n");
  });

  it("applies per-column formatters", () => {
    const bytes = buildCsv(
      [{ n: 3.14159 }],
      [{ key: "n", header: "Number", format: (v) => (v as number).toFixed(2) }],
    );
    expect(decode(bytes)).toBe("\uFEFFNumber\r\n3.14\r\n");
  });
});

describe("buildCsvFromMatrix", () => {
  it("prepends BOM and joins with CRLF", () => {
    const bytes = buildCsvFromMatrix([["h1", "h2"], ["a", "b"]]);
    expect(decode(bytes)).toBe("\uFEFFh1,h2\r\na,b\r\n");
  });
});

describe("csvStringToBytes", () => {
  it("prepends BOM and normalizes LF to CRLF", () => {
    const bytes = csvStringToBytes("a,b\nc,d");
    expect(decode(bytes)).toBe("\uFEFFa,b\r\nc,d");
  });

  it("is idempotent for input that already has a BOM", () => {
    const bytes = csvStringToBytes("\uFEFFa,b");
    const text = decode(bytes);
    // Only one leading BOM.
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text.slice(1).startsWith("\uFEFF")).toBe(false);
  });
});
