/**
 * WeasyPrintProducer — request-shape unit test.
 *
 * Verifies the producer signs the request body with HMAC-SHA256 hex,
 * POSTs the correct content type, and surfaces sidecar errors as
 * structured exceptions. The sidecar itself lives in
 * infra/cert-renderer/ and is exercised in its own integration test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WeasyPrintProducer } from "../../../supabase/functions/_shared/certificate-engine/weasyPrintProducer";

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

describe("WeasyPrintProducer", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { /* noop */ });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("signs and posts a JSON body, returns PDF bytes", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]); // "%PDF-1.5"
    const seen: { url?: string; headers?: Headers; body?: string } = {};

    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      seen.url = url;
      seen.headers = new Headers(init.headers as any);
      seen.body = init.body as string;
      return new Response(pdfBytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }) as any;

    const producer = new WeasyPrintProducer({
      url: "http://renderer:8080/render",
      signing_secret: "test-secret",
    });
    const html = "<!doctype html><html><body>x</body></html>";
    const out = await producer.produce(html);

    expect(out).toEqual(pdfBytes);
    expect(seen.url).toBe("http://renderer:8080/render");
    expect(seen.headers?.get("content-type")).toBe("application/json");
    const expectedBody = JSON.stringify({ html });
    expect(seen.body).toBe(expectedBody);
    expect(seen.headers?.get("x-signature")).toBe(
      await expectedSignature("test-secret", expectedBody),
    );
  });

  it("rejects non-PDF responses", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not pdf", {
      status: 200, headers: { "content-type": "text/plain" },
    })) as any;
    const producer = new WeasyPrintProducer({ url: "http://x/render", signing_secret: "s" });
    await expect(producer.produce("<html/>")).rejects.toThrow(/non-PDF/);
  });

  it("surfaces sidecar HTTP errors", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad signature", { status: 401 })) as any;
    const producer = new WeasyPrintProducer({ url: "http://x/render", signing_secret: "s" });
    await expect(producer.produce("<html/>")).rejects.toThrow(/HTTP 401/);
  });
});
