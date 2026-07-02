import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizePhoneE164,
  resolveSender,
  sendSms,
  TWILIO_TEST_MAGIC_FROM,
  type TwilioConfig,
} from "../twilio.ts";

const baseConfig = (overrides: Partial<TwilioConfig> = {}): TwilioConfig => ({
  account_sid: "AC" + "a".repeat(32),
  auth_token: "x".repeat(32),
  sender_phone: null,
  messaging_service_sid: null,
  provider_mode: "test",
  ...overrides,
});

Deno.test("normalizePhoneE164 accepts valid E.164", () => {
  assertEquals(normalizePhoneE164("+14155552671"), "+14155552671");
  assertEquals(normalizePhoneE164("+15005550006"), "+15005550006");
  assertEquals(normalizePhoneE164(" +1 (415) 555-2671 "), "+14155552671");
});

Deno.test("normalizePhoneE164 rejects invalid input", () => {
  assertEquals(normalizePhoneE164(""), null);
  assertEquals(normalizePhoneE164("4155552671"), null);
  assertEquals(normalizePhoneE164("+0123"), null);
  assertEquals(normalizePhoneE164("+abcdefg"), null);
  assertEquals(normalizePhoneE164(null), null);
});

Deno.test("resolveSender — test mode forces magic From and ignores Messaging Service", () => {
  const r = resolveSender(baseConfig({
    provider_mode: "test",
    sender_phone: "+14155552671",
    messaging_service_sid: "MG" + "1".repeat(32),
  }));
  assertEquals(r.ok, true);
  assertEquals(r.sender?.From, TWILIO_TEST_MAGIC_FROM);
  assertEquals(r.sender?.MessagingServiceSid, undefined);
});

Deno.test("resolveSender — live mode prefers MessagingServiceSid", () => {
  const r = resolveSender(baseConfig({
    provider_mode: "live",
    sender_phone: "+14155552671",
    messaging_service_sid: "MG" + "1".repeat(32),
  }));
  assertEquals(r.ok, true);
  assertEquals(r.sender?.MessagingServiceSid, "MG" + "1".repeat(32));
  assertEquals(r.sender?.From, undefined);
});

Deno.test("resolveSender — live mode falls back to From phone", () => {
  const r = resolveSender(baseConfig({ provider_mode: "live", sender_phone: "+14155552671" }));
  assertEquals(r.ok, true);
  assertEquals(r.sender?.From, "+14155552671");
});

Deno.test("resolveSender — live mode without sender or service is invalid", () => {
  const r = resolveSender(baseConfig({ provider_mode: "live" }));
  assertEquals(r.ok, false);
  assertEquals(r.code, "INVALID_SENDER");
});

Deno.test("sendSms — short-circuits on invalid recipient before hitting Twilio", async () => {
  const r = await sendSms({ to: "not-a-phone", body: "hi", config: baseConfig() });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "INVALID_RECIPIENT");
});

Deno.test("sendSms — short-circuits on empty body", async () => {
  const r = await sendSms({ to: "+15005550006", body: "   ", config: baseConfig() });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "MESSAGE_EMPTY");
});

Deno.test("sendSms — short-circuits on missing credentials", async () => {
  const r = await sendSms({
    to: "+15005550006",
    body: "hi",
    config: baseConfig({ account_sid: "", auth_token: "" }),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "CONFIG_MISSING");
});

Deno.test("sendSms — Twilio 21659 in test mode is mapped to TEST_CREDENTIALS_MISMATCH", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ code: 21659, message: "From not owned" }), { status: 400 }),
    )) as typeof fetch;
  try {
    const r = await sendSms({
      to: "+15005550006",
      body: "hi",
      config: baseConfig({ provider_mode: "test" }),
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.code, "TEST_CREDENTIALS_MISMATCH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendSms — Twilio 21659 in live mode is SENDER_NOT_OWNED", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ code: 21659, message: "From not owned" }), { status: 400 }),
    )) as typeof fetch;
  try {
    const r = await sendSms({
      to: "+14155552671",
      body: "hi",
      config: baseConfig({ provider_mode: "live", sender_phone: "+18777804236" }),
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.code, "SENDER_NOT_OWNED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendSms — success echoes the From in result", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ sid: "SM" + "x".repeat(32), status: "queued" }), { status: 201 }),
    )) as typeof fetch;
  try {
    const r = await sendSms({
      to: "+14155552671",
      body: "hi",
      config: baseConfig({ provider_mode: "live", sender_phone: "+18777804236" }),
    });
    assertEquals(r.ok, true);
    if (r.ok) assertEquals(r.from, "+18777804236");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
