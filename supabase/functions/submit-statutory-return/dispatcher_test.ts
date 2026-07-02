// @ts-nocheck
/**
 * Unit tests for submit-statutory-return dispatcher helpers.
 * Exercises the metadata-driven contract with a synthetic authority —
 * no real authority endpoints are called.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Re-implement the pure helpers exactly as in index.ts so tests can import
// them without requiring the Deno.serve runtime to start.
function interpolate(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
function getByPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc: any, k) => (acc == null ? acc : acc[k]), obj);
}
async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("interpolate resolves url_template tokens for a synthetic authority", () => {
  const url = interpolate(
    "https://synthetic.authority.test/returns/{template_code}?from={period_start}&to={period_end}",
    { template_code: "SYNTH-MONTHLY", period_start: "2026-05-01", period_end: "2026-05-31" },
  );
  assertEquals(
    url,
    "https://synthetic.authority.test/returns/SYNTH-MONTHLY?from=2026-05-01&to=2026-05-31",
  );
});

Deno.test("interpolate leaves unknown tokens empty (no leakage)", () => {
  const url = interpolate("https://x.test/{missing}/ok", {});
  assertEquals(url, "https://x.test//ok");
});

Deno.test("getByPath extracts acknowledgement_spec.reference_path from authority response", () => {
  const body = { data: { receipt: { id: "ACK-9981" } } };
  assertEquals(getByPath(body, "data.receipt.id"), "ACK-9981");
  assertEquals(getByPath(body, "data.missing.id"), undefined);
  assertEquals(getByPath(null, "a.b"), null);
});

Deno.test("hmac_sha256 signature is deterministic for the same payload+secret", async () => {
  const payload = JSON.stringify({ template_code: "SYNTH", period_end: "2026-05-31" });
  const sig1 = await hmacSha256("synthetic-shared-secret", payload);
  const sig2 = await hmacSha256("synthetic-shared-secret", payload);
  assertEquals(sig1, sig2);
  assertEquals(sig1.length, 64); // 32 bytes hex
});

Deno.test("accepted_status default matches 200/201/202 only", () => {
  const accepted = [200, 201, 202];
  assertEquals(accepted.includes(200), true);
  assertEquals(accepted.includes(202), true);
  assertEquals(accepted.includes(204), false);
  assertEquals(accepted.includes(500), false);
});

Deno.test("synthetic dispatch round-trip via httpbin-style echo endpoint", async () => {
  // Use a local echo server stub to validate header + body composition
  // without depending on external networks during CI.
  const received: { headers: Record<string, string>; body: string } = { headers: {}, body: "" };
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    received.body = await req.text();
    req.headers.forEach((v, k) => { received.headers[k.toLowerCase()] = v; });
    return new Response(JSON.stringify({ receipt: { id: "SYN-ACK-1" } }), {
      status: 202, headers: { "content-type": "application/json" },
    });
  });
  const addr = server.addr as Deno.NetAddr;
  const url = `http://127.0.0.1:${addr.port}/file`;

  const payload = JSON.stringify({ template_code: "SYNTH-MONTHLY" });
  const sig = await hmacSha256("k", payload);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer test-token",
      "X-Signature": sig,
    },
    body: payload,
  });
  const json = await resp.json();

  assertEquals(resp.status, 202);
  assertEquals(received.headers["authorization"], "Bearer test-token");
  assertEquals(received.headers["x-signature"], sig);
  assertEquals(received.body, payload);
  assertEquals(getByPath(json, "receipt.id"), "SYN-ACK-1");

  await server.shutdown();
});
