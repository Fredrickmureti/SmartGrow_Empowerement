// @ts-nocheck — Deno runtime
/**
 * xmlWriter — declarative XML writer for `submission_format.type = 'gov_xml'`.
 *
 * Pack authors describe the XML shape declaratively; this writer materializes
 * the document with no per-country branching. Suitable for KRA P10 XML,
 * India 24Q, German ELStAM, SARS EMP501 element streams.
 *
 * submission_format.xml shape:
 *   {
 *     "type": "gov_xml",
 *     "root": "Return",                              // root element name
 *     "namespace": "urn:kra:p10:2024",               // default xmlns (optional)
 *     "header": { "TaxPeriod": "2024-12" },          // static elements (optional)
 *     "rows": {
 *       "wrapper": "Employees",                      // element wrapping rows
 *       "element": "Employee",                       // element per row
 *       "fields": [                                  // mapping per cell
 *         { "path": "PIN",          "source": "employee.tax_pin" },
 *         { "path": "Name",         "source": "employee.full_name" },
 *         { "path": "GrossPay",     "source": "sum_taxable_amount",  "format": "fixed2" },
 *         { "path": "PAYEDeducted", "source": "sum_employee_amount", "format": "fixed2" }
 *       ]
 *     },
 *     "footer": { "TotalRecords": { "source": "row_count" } }   // optional
 *   }
 */

import { readSource as resolveSource, type SourceContext } from "./returnSourceResolver.ts";

export interface XmlField {
  path: string;
  source: string;
  format?: "fixed2" | "int" | "raw";
}

export interface XmlSubmissionFormat {
  type?: "gov_xml";
  root?: string;
  namespace?: string;
  header?: Record<string, unknown>;
  rows?: { wrapper?: string; element?: string; fields: XmlField[] };
  footer?: Record<string, { source: string; format?: XmlField["format"] }>;
}

export type XmlRowContext = SourceContext;

function xmlEscape(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readSource(source: string, ctx: XmlRowContext): unknown {
  return resolveSource(source, ctx);
}

function applyFormat(v: unknown, fmt?: XmlField["format"]): string {
  if (fmt === "fixed2") return (Number(v) || 0).toFixed(2);
  if (fmt === "int") return String(Math.trunc(Number(v) || 0));
  return v === null || v === undefined ? "" : String(v);
}

export function renderGovXml(
  fmt: XmlSubmissionFormat,
  rows: XmlRowContext[],
): Uint8Array {
  if (!fmt || fmt.type !== "gov_xml") {
    throw new Error("renderGovXml requires submission_format.type='gov_xml'");
  }
  const root = fmt.root ?? "Return";
  const ns = fmt.namespace ? ` xmlns="${xmlEscape(fmt.namespace)}"` : "";

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<${root}${ns}>`);

  if (fmt.header) {
    for (const [k, v] of Object.entries(fmt.header)) {
      parts.push(`<${k}>${xmlEscape(v)}</${k}>`);
    }
  }

  if (fmt.rows?.fields?.length) {
    const wrap = fmt.rows.wrapper;
    const el = fmt.rows.element ?? "Row";
    if (wrap) parts.push(`<${wrap}>`);
    for (const ctx of rows) {
      parts.push(`<${el}>`);
      for (const f of fmt.rows.fields) {
        const raw = readSource(f.source, ctx);
        parts.push(`<${f.path}>${xmlEscape(applyFormat(raw, f.format))}</${f.path}>`);
      }
      parts.push(`</${el}>`);
    }
    if (wrap) parts.push(`</${wrap}>`);
  }

  if (fmt.footer) {
    for (const [k, spec] of Object.entries(fmt.footer)) {
      let val: unknown;
      if (spec.source === "row_count") val = rows.length;
      else {
        // aggregate across rows for sum_* sources
        val = rows.reduce((a, ctx) => a + (Number(readSource(spec.source, ctx)) || 0), 0);
      }
      parts.push(`<${k}>${xmlEscape(applyFormat(val, spec.format))}</${k}>`);
    }
  }

  parts.push(`</${root}>`);
  return new TextEncoder().encode(parts.join(""));
}

export const XML_CONTENT_TYPE = "application/xml";
