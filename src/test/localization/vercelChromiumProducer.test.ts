/**
 * VercelChromiumProducer — request-shape unit test.
 * Producer signs the body with HMAC-SHA256 hex and POSTs to the Vercel
 * `/api/render-certificate` route; the route (api/render-certificate.ts)
 * rasterises with @sparticuz/chromium + puppeteer-core.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { VercelChromiumProducer } from "../../../supabase/functions/_shared/certificate-engine/vercelChromiumProducer";

async function expectedSignature(secret: string, body: string): Promise<string> {
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

describe("VercelChromiumProducer", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("signs and posts a JSON body, returns PDF bytes", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]);
    const seen: { url?: string; headers?: Headers; body?: string } = {};

    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.url = url;
      seen.headers = new Headers(init.headers as any);
      seen.body = init.body as string;
      return new Response(pdfBytes, {
        status: 200, headers: { "content-type": "application/pdf" },
      });
    }) as any;

    const producer = new VercelChromiumProducer({
      url: "https://app.vercel.app/api/render-certificate",
      signing_secret: "test-secret",
    });
    const html = "<!doctype html><html><body>x</body></html>";
    const out = await producer.produce(html);

    expect(out).toEqual(pdfBytes);
    expect(seen.url).toBe("https://app.vercel.app/api/render-certificate");
    expect(seen.headers?.get("content-type")).toBe("application/json");
    const expectedBody = JSON.stringify({ html });
    expect(seen.body).toBe(expectedBody);
    expect(seen.headers?.get("x-signature")).toBe(
      await expectedSignature("test-secret", expectedBody),
    );
  });

  it("rejects non-PDF responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", {
      status: 200, headers: { "content-type": "text/plain" },
    })) as any;
    const producer = new VercelChromiumProducer({ url: "http://x", signing_secret: "s" });
    await expect(producer.produce("<html/>")).rejects.toThrow(/non-PDF/);
  });

  it("surfaces HTTP errors from the route", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad signature", { status: 401 })) as any;
    const producer = new VercelChromiumProducer({ url: "http://x", signing_secret: "s" });
    await expect(producer.produce("<html/>")).rejects.toThrow(/HTTP 401/);
  });
});
