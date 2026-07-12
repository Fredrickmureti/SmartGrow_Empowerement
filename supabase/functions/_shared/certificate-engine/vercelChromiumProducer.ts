// @ts-nocheck — Deno runtime
/**
 * VercelChromiumProducer — v3 PdfProducer that calls the in-repo Vercel
 * serverless route at `/api/render-certificate` (see api/render-certificate.ts).
 *
 * This is owned infrastructure inside this same codebase — no Docker,
 * no K8s, no third-party API. Odoo pattern: platform owns the engine.
 *
 * Config via env (Supabase edge secrets):
 *   CERT_RENDERER_URL             absolute URL of the Vercel route
 *                                 e.g. https://your-app.vercel.app/api/render-certificate
 *   CERT_RENDERER_SIGNING_SECRET  shared HMAC-SHA256 secret; the same
 *                                 value must be set on Vercel.
 */
import type { PdfProducer } from "./engine.ts";

export interface VercelChromiumProducerConfig {
  url: string;
  signing_secret: string;
  timeout_ms?: number;
}

export class VercelChromiumProducer implements PdfProducer {
  constructor(private readonly cfg: VercelChromiumProducerConfig) {
    if (!cfg.url) throw new Error("VercelChromiumProducer: url required");
    if (!cfg.signing_secret) throw new Error("VercelChromiumProducer: signing_secret required");
  }

  async produce(html: string): Promise<Uint8Array> {
    const body = JSON.stringify({ html });
    const signature = await hmacSha256Hex(this.cfg.signing_secret, body);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeout_ms ?? 55_000);
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

/** Build a producer from Supabase edge env, or null if not configured. */
export function producerFromEnv(): VercelChromiumProducer | null {
  const url = Deno.env.get("CERT_RENDERER_URL");
  const secret = Deno.env.get("CERT_RENDERER_SIGNING_SECRET");
  if (!url || !secret) return null;
  return new VercelChromiumProducer({ url, signing_secret: secret });
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
