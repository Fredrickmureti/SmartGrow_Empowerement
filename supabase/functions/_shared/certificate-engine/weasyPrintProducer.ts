// @ts-nocheck — Deno runtime
/**
 * WeasyPrintProducer — v3 PdfProducer that talks to the self-hosted
 * paged-media sidecar (see infra/cert-renderer/).
 *
 * Signed with HMAC-SHA256 over the raw JSON body. The shared secret
 * lives in Supabase edge-function env as CERT_RENDERER_SIGNING_SECRET;
 * the endpoint URL is CERT_RENDERER_URL. Both must be set for v3
 * rendering; otherwise the dispatcher falls back to `UnwiredPdfProducer`
 * and surfaces a structured "renderer not configured" business error.
 *
 * This is owned infrastructure, not a third-party API — same pattern
 * Odoo uses with its wkhtmltopdf sidecar.
 */
import type { PdfProducer } from "./engine.ts";

export interface WeasyPrintProducerConfig {
  url: string;              // e.g. http://cert-renderer:8080/render
  signing_secret: string;   // shared HMAC secret
  timeout_ms?: number;      // default 30_000
}

export class WeasyPrintProducer implements PdfProducer {
  constructor(private readonly cfg: WeasyPrintProducerConfig) {
    if (!cfg.url) throw new Error("WeasyPrintProducer: url required");
    if (!cfg.signing_secret) throw new Error("WeasyPrintProducer: signing_secret required");
  }

  async produce(html: string): Promise<Uint8Array> {
    const body = JSON.stringify({ html });
    const bodyBytes = new TextEncoder().encode(body);
    const signature = await hmacSha256Hex(this.cfg.signing_secret, bodyBytes);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeout_ms ?? 30_000);
    try {
      const res = await fetch(this.cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": signature,
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`cert-renderer HTTP ${res.status}: ${detail.slice(0, 400)}`);
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/pdf")) {
        throw new Error(`cert-renderer returned non-PDF content-type: ${ct}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0x25 || buf[1] !== 0x50) {
        throw new Error("cert-renderer returned bytes that are not a PDF");
      }
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a producer from env, or return null if not configured.
 * The dispatcher uses this to gate v3 rendering.
 */
export function producerFromEnv(): WeasyPrintProducer | null {
  const url = Deno.env.get("CERT_RENDERER_URL");
  const secret = Deno.env.get("CERT_RENDERER_SIGNING_SECRET");
  if (!url || !secret) return null;
  return new WeasyPrintProducer({ url, signing_secret: secret });
}

async function hmacSha256Hex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
