/**
 * PIN login server function.
 *
 * Authenticates a user from email + PIN without a prior session:
 * 1. verify_pin_full RPC — profile lookup + PIN-enabled check + PIN verify (with lockout)
 * 2. admin generateLink — mints a magic-link token for that email
 * 3. verifyOtp — exchanges the token for a real session
 *
 * The service-role key is read inside the handler and never leaves the server.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

export interface PinLoginResult {
  success: boolean;
  error?: string;
  locked?: boolean;
  locked_until?: string;
  attempts_remaining?: number;
  session?: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
  };
}

export const pinLogin = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string; pin: string }) => {
    const email = String(input?.email ?? "").trim().toLowerCase();
    const pin = String(input?.pin ?? "").trim();
    if (!email.includes("@")) throw new Error("A valid email is required");
    if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4-6 digits");
    return { email, pin };
  })
  .handler(async ({ data }): Promise<PinLoginResult> => {
    const { resolveServerSupabaseConfig, describeMissingServerSupabaseConfig } =
      await import("./serverSupabaseConfig.server");
    const { config, missing } = resolveServerSupabaseConfig();

    if (!config) {
      const detail = describeMissingServerSupabaseConfig(missing);
      console.error(`[pinLogin] ${detail}`);
      return {
        success: false,
        error: `PIN login is not configured: missing ${missing.join(", ")}`,
      };
    }

    const supabaseUrl = config.url;
    const serviceRoleKey = config.serviceRoleKey;
    const anonKey = config.publishableKey;

    const authOptions = {
      auth: { autoRefreshToken: false, persistSession: false },
    } as const;
    const adminClient = createClient(supabaseUrl, serviceRoleKey, authOptions);


    const { data: verifyResult, error: verifyError } = await adminClient.rpc(
      "verify_pin_full",
      { p_email: data.email, p_pin: data.pin },
    );

    if (verifyError) {
      console.error("verify_pin_full failed:", verifyError.message);
      return { success: false, error: "Verification failed" };
    }

    const result = (verifyResult ?? {}) as {
      success?: boolean;
      error?: string;
      locked?: boolean;
      locked_until?: string;
      attempts_remaining?: number;
    };

    if (!result.success) {
      return {
        success: false,
        error: result.error ?? "Invalid PIN",
        locked: result.locked ?? false,
        ...(result.locked_until ? { locked_until: result.locked_until } : {}),
        ...(result.attempts_remaining !== undefined
          ? { attempts_remaining: result.attempts_remaining }
          : {}),
      };
    }

    const { data: linkData, error: linkError } =
      await adminClient.auth.admin.generateLink({
        type: "magiclink",
        email: data.email,
      });

    const tokenHash = linkData?.properties?.hashed_token;
    if (linkError || !tokenHash) {
      console.error("generateLink failed:", linkError?.message);
      return { success: false, error: "Authentication failed" };
    }

    const anonClient = createClient(supabaseUrl, anonKey, authOptions);
    const { data: sessionData, error: sessionError } =
      await anonClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });

    if (sessionError || !sessionData?.session) {
      console.error("verifyOtp failed:", sessionError?.message);
      return { success: false, error: "Authentication failed" };
    }

    const session = sessionData.session;
    return {
      success: true,
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        ...(session.expires_in !== undefined
          ? { expires_in: session.expires_in }
          : {}),
        ...(session.expires_at !== undefined
          ? { expires_at: session.expires_at }
          : {}),
        ...(session.token_type ? { token_type: session.token_type } : {}),
      },
    };
  });
