import { describe, expect, it } from "vitest";
import {
  describeMissingServerSupabaseConfig,
  resolveServerSupabaseConfig,
} from "@/lib/serverSupabaseConfig.server";

const CONFIG_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
] as const;

function withClearedEnv(run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveServerSupabaseConfig", () => {
  it("names the privileged server key when it is absent", () => {
    withClearedEnv(() => {
      process.env.SUPABASE_URL = "https://project.supabase.co";
      process.env.SUPABASE_PUBLISHABLE_KEY = "public-key";

      const result = resolveServerSupabaseConfig();

      expect(result.config).toBeUndefined();
      expect(result.missing).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
      expect(describeMissingServerSupabaseConfig(result.missing)).toContain(
        "SUPABASE_SERVICE_ROLE_KEY",
      );
    });
  });

  it("accepts the complete server contract without browser-only fallbacks", () => {
    withClearedEnv(() => {
      process.env.SUPABASE_URL = "https://project.supabase.co";
      process.env.SUPABASE_PUBLISHABLE_KEY = "public-key";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "server-secret";

      expect(resolveServerSupabaseConfig()).toEqual({
        missing: [],
        config: {
          url: "https://project.supabase.co",
          publishableKey: "public-key",
          serviceRoleKey: "server-secret",
        },
      });
    });
  });
});
