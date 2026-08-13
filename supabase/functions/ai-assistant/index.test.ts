import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FN_URL = `${SUPABASE_URL}/functions/v1/ai-assistant`;

Deno.test("OPTIONS preflight succeeds with CORS headers", async () => {
  const res = await fetch(FN_URL, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:8080",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, apikey",
    },
  });
  await res.text();
  assert(res.ok, `preflight must be 2xx, got ${res.status}`);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  for (const h of ["authorization", "content-type", "apikey", "x-client-info"]) {
    assert(allowed.includes(h), `preflight must allow ${h}`);
  }
});

Deno.test("POST without Authorization is rejected with CORS headers", async () => {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:8080" },
    body: JSON.stringify({ type: "chat", messages: [] }),
  });
  const body = await res.text();
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(body.includes("unauthorized") || body.includes("Unauthorized"));
});
