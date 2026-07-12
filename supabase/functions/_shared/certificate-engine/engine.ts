// @ts-nocheck — Deno runtime
/**
 * Certificate Engine v3 — entry point.
 *
 * Pure, country-agnostic. The engine does two things:
 *   1. compile(template, payload) → { html, css, unresolved }
 *   2. produce(html) → Uint8Array (PDF bytes) via a pluggable PdfProducer
 *
 * The choice of PDF producer is an implementation detail decided in
 * Phase B. Phase A ships the interface + a stub that throws, so
 * `generate-tax-certificate` can be wired to dispatch on
 * `schema_version === 3` without committing to a runtime yet.
 */
import type { CertificatePayload, CertificateTemplateV3 } from "./types.ts";
import { compile, type CompileOptions, type CompileResult } from "./compile.ts";

export interface PdfProducer {
  /** Rasterise a self-contained HTML document to PDF bytes. */
  produce(html: string): Promise<Uint8Array>;
}

export interface RenderResult {
  bytes: Uint8Array;
  html: string;
  unresolved: string[];
}

export interface RenderOptions extends CompileOptions {
  producer: PdfProducer;
}

export async function renderCertificate(
  template: CertificateTemplateV3,
  payload: CertificatePayload,
  opts: RenderOptions,
): Promise<RenderResult> {
  const compiled: CompileResult = compile(template, payload, opts);
  const bytes = await opts.producer.produce(compiled.html);
  return { bytes, html: compiled.html, unresolved: compiled.unresolved };
}

/** Placeholder producer — Phase B replaces this with the real engine. */
export class UnwiredPdfProducer implements PdfProducer {
  produce(_html: string): Promise<Uint8Array> {
    return Promise.reject(new Error(
      "certificate-engine: no PdfProducer wired yet. " +
      "Phase B decides the runtime; the engine interface is stable.",
    ));
  }
}

export { compile } from "./compile.ts";
export * from "./types.ts";
