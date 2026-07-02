import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendSms, type TwilioConfig } from "../twilio.ts";

const baseConfig = (overrides: Partial<TwilioConfig> = {}): TwilioConfig => ({
  account_sid: "AC" + "a".repeat(32),
  auth_token: "x".repeat(32),
  sender_phone: "+18777804236",
  messaging_service_sid: null,
  provider_mode: "live",
  ...overrides,
});

Deno.test("sendSms — 401 maps to TWILIO_AUTH_FAILED and is permanent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ code: 20003, message: "Auth failed" }), { status: 401 }))) as typeof fetch;
  try {
    const r = await sendSms({ to: "+14155552671", body: "hi", config: baseConfig() });
    assertEquals(r.ok, false);
    if (!r.ok) {
      assertEquals(r.code, "TWILIO_AUTH_FAILED");
      assertEquals(r.permanent, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendSms — 5xx is transient (will retry)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 503 }))) as typeof fetch;
  try {
    const r = await sendSms({ to: "+14155552671", body: "hi", config: baseConfig() });
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.permanent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendSms — success captures price + price_unit when provided", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify({
      sid: "SM" + "x".repeat(32),
      status: "queued",
      price: "-0.0075",
      price_unit: "USD",
    }), { status: 201 }))) as typeof fetch;
  try {
    const r = await sendSms({ to: "+14155552671", body: "hi", config: baseConfig() });
    assertEquals(r.ok, true);
    if (r.ok) {
      assertEquals(r.price, "-0.0075");
      assertEquals(r.price_unit, "USD");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
