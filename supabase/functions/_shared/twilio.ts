// =====================================================================
// Shared Twilio provider — single source of truth for SMS sending
// =====================================================================
// Used by both `send-sms` (operational) and `test-sms-connection` (config
// validation) so the two flows can never drift apart again.
//
// References (Twilio public docs):
//  - Test Credentials & magic numbers:
//    https://www.twilio.com/docs/iam/test-credentials
//  - REST API error codes:
//    https://www.twilio.com/docs/api/errors
//  - Toll-free verification:
//    https://www.twilio.com/docs/messaging/compliance/toll-free-message-verification
// =====================================================================

/** Twilio test-credentials magic sender number — required for SMS in test mode */
export const TWILIO_TEST_MAGIC_FROM = "+15005550006";

export type SmsMode = "test" | "live";

export interface TwilioConfig {
  account_sid: string;
  auth_token: string;
  sender_phone: string | null;
  messaging_service_sid: string | null;
  provider_mode: SmsMode;
}

/** Application-level error codes returned to the client. Stable contract. */
export type SmsErrorCode =
  | "CONFIG_MISSING"
  | "INVALID_RECIPIENT"
  | "INVALID_SENDER"
  | "TEST_MODE_UNSUPPORTED_PARAM"
  | "TEST_CREDENTIALS_MISMATCH"
  | "TWILIO_AUTH_FAILED"
  | "TWILIO_REJECTED"
  | "TOLLFREE_NOT_VERIFIED"
  | "RECIPIENT_OPTED_OUT"
  | "SENDER_NOT_OWNED"
  | "UNREACHABLE_CARRIER"
  | "MESSAGE_EMPTY"
  | "RATE_LIMITED"
  | "OPTED_OUT"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "UNKNOWN_ERROR";

export interface SmsSendOk {
  ok: true;
  sid: string;
  mode: SmsMode;
  status: string; // Twilio message status (queued|sending|sent|...)
  /** Sender Twilio actually accepted (echoed back from request payload). */
  from?: string | null;
  /** Twilio price (negative number string) and currency, when present. */
  price?: string | null;
  price_unit?: string | null;
}

export interface SmsSendErr {
  ok: false;
  code: SmsErrorCode;
  message: string;
  twilio_code?: number;
  twilio_status?: number;
  /** Whether the error is permanent (no point retrying). Set by mapTwilioError. */
  permanent?: boolean;
  /** HTTP status from provider — useful for retry decisions if no twilio_code. */
  http_status?: number;
}

export type SmsSendResult = SmsSendOk | SmsSendErr;

// ---------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Strict E.164 validator — does not attempt to "fix" national-format input. */
export function normalizePhoneE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/[\s\-()]/g, "");
  if (!E164_RE.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------
// Sender resolution — enforces test/live mode rules
// ---------------------------------------------------------------------

export interface ResolvedSender {
  // Exactly one of these is set
  From?: string;
  MessagingServiceSid?: string;
}

export interface SenderResolution {
  ok: boolean;
  sender?: ResolvedSender;
  code?: SmsErrorCode;
  message?: string;
}

export function resolveSender(config: TwilioConfig): SenderResolution {
  if (config.provider_mode === "test") {
    // Test credentials: Twilio only accepts the magic From number for SMS,
    // and reject MessagingServiceSid entirely (error 21712).
    return {
      ok: true,
      sender: { From: TWILIO_TEST_MAGIC_FROM },
    };
  }

  // Live mode: prefer Messaging Service when configured, otherwise From.
  if (config.messaging_service_sid && config.messaging_service_sid.trim()) {
    return {
      ok: true,
      sender: { MessagingServiceSid: config.messaging_service_sid.trim() },
    };
  }
  const from = normalizePhoneE164(config.sender_phone);
  if (from) {
    return { ok: true, sender: { From: from } };
  }
  return {
    ok: false,
    code: "INVALID_SENDER",
    message:
      "Live mode requires either a verified sender phone number (E.164) or a Messaging Service SID configured for this organization.",
  };
}

// ---------------------------------------------------------------------
// Twilio error mapping
// ---------------------------------------------------------------------

interface TwilioApiError {
  code?: number;
  message?: string;
  status?: number;
  more_info?: string;
}

function mapTwilioError(httpStatus: number, body: TwilioApiError, mode: SmsMode): SmsSendErr {
  const tcode = typeof body.code === "number" ? body.code : undefined;
  const msg = body.message || `Twilio request failed with HTTP ${httpStatus}`;
  // Default: permanent for 4xx (except 429 rate-limit), transient for 5xx / network.
  const permanent = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429;

  const base = (e: SmsSendErr): SmsSendErr => ({ ...e, permanent: e.permanent ?? permanent, http_status: httpStatus });

  switch (tcode) {
    case 20003:
      return base({ ok: false, code: "TWILIO_AUTH_FAILED", message: "Twilio authentication failed. Check Account SID and Auth Token.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21211:
    case 21214:
    case 21614:
      return base({ ok: false, code: "INVALID_RECIPIENT", message: "Recipient phone number is invalid or not SMS-capable.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21606:
    case 21608:
      return base({ ok: false, code: "INVALID_SENDER", message: "Sender phone is not SMS-capable or not enabled for the destination.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21610:
      return base({ ok: false, code: "RECIPIENT_OPTED_OUT", message: "Recipient has opted out of receiving SMS from this sender.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21612:
      return base({ ok: false, code: "UNREACHABLE_CARRIER", message: "The destination carrier is unreachable from this sender.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21659:
    case 21660:
      if (mode === "test") {
        return base({
          ok: false,
          code: "TEST_CREDENTIALS_MISMATCH",
          message:
            "You selected Test mode but the credentials look like Live credentials. Twilio only accepts +15005550006 as the sender when authenticated with Test Credentials. Either paste your Test Credentials from twilio.com/console (separate from your live keys), or switch to Live mode and use a number you own (e.g. a Twilio Virtual Phone Number).",
          twilio_code: tcode,
          twilio_status: httpStatus,
          permanent: true,
        });
      }
      return base({ ok: false, code: "SENDER_NOT_OWNED", message: "Sender phone number is not owned by this Twilio account or is not SMS-enabled.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 21712:
      return base({ ok: false, code: "TEST_MODE_UNSUPPORTED_PARAM", message: "Twilio test credentials do not support Messaging Service SID. Switch to live mode or remove the Messaging Service.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    case 30032:
    case 30033:
    case 63032:
      return base({ ok: false, code: "TOLLFREE_NOT_VERIFIED", message: "US toll-free sender requires Twilio toll-free verification before sending SMS.", twilio_code: tcode, twilio_status: httpStatus, permanent: true });
    default:
      return base({ ok: false, code: "TWILIO_REJECTED", message: msg, twilio_code: tcode, twilio_status: httpStatus });
  }
}

// ---------------------------------------------------------------------
// Sanitization (never log secrets)
// ---------------------------------------------------------------------

export function sanitizeForLog(value: string | null | undefined, accountSid?: string): string | null {
  if (!value) return null;
  let out = value;
  if (accountSid) out = out.split(accountSid).join("AC***");
  // Truncate to keep logs/DB bounded
  return out.length > 500 ? out.slice(0, 500) + "…" : out;
}

// ---------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------

export interface SendArgs {
  to: string;
  body: string;
  config: TwilioConfig;
  /** Status callback URL — only used in live mode. Test mode never callbacks. */
  statusCallbackUrl?: string;
}

export async function sendSms(args: SendArgs): Promise<SmsSendResult> {
  const { to, body, config, statusCallbackUrl } = args;

  if (!config.account_sid || !config.auth_token) {
    return { ok: false, code: "CONFIG_MISSING", message: "Twilio credentials are not configured." };
  }
  if (!body || !body.trim()) {
    return { ok: false, code: "MESSAGE_EMPTY", message: "Message body is empty." };
  }
  const normalizedTo = normalizePhoneE164(to);
  if (!normalizedTo) {
    return { ok: false, code: "INVALID_RECIPIENT", message: "Recipient phone number must be in E.164 format (e.g. +14155552671)." };
  }

  const senderRes = resolveSender(config);
  if (!senderRes.ok || !senderRes.sender) {
    return {
      ok: false,
      code: senderRes.code || "INVALID_SENDER",
      message: senderRes.message || "Could not resolve a sender.",
    };
  }

  const form = new URLSearchParams();
  form.append("To", normalizedTo);
  form.append("Body", body);
  if (senderRes.sender.From) form.append("From", senderRes.sender.From);
  if (senderRes.sender.MessagingServiceSid) form.append("MessagingServiceSid", senderRes.sender.MessagingServiceSid);
  // Status callback only in live mode — Twilio test credentials do not invoke callbacks.
  if (config.provider_mode === "live" && statusCallbackUrl) {
    form.append("StatusCallback", statusCallbackUrl);
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${config.account_sid}/Messages.json`;

  let response: Response;
  try {
    response = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${config.account_sid}:${config.auth_token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      code: "TWILIO_REJECTED",
      message: `Could not reach Twilio API: ${(err as Error).message}`,
      permanent: false,
      http_status: 0,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    return mapTwilioError(response.status, payload as TwilioApiError, config.provider_mode);
  }

  const sid = typeof payload.sid === "string" ? payload.sid : "";
  const status = typeof payload.status === "string" ? payload.status : "queued";
  if (!sid) {
    return {
      ok: false,
      code: "TWILIO_REJECTED",
      message: "Twilio responded OK but did not return a message SID.",
      twilio_status: response.status,
      permanent: true,
      http_status: response.status,
    };
  }

  return {
    ok: true,
    sid,
    status,
    mode: config.provider_mode,
    from: senderRes.sender.From ?? null,
    price: typeof payload.price === "string" ? payload.price : null,
    price_unit: typeof payload.price_unit === "string" ? payload.price_unit : null,
  };
}
