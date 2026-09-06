/**
 * Single place that resolves the server-side Supabase configuration.
 *
 * Every server-side feature that needs Supabase credentials (PIN login being
 * the first) reads them here, so the variable names and the failure message are
 * identical everywhere instead of each file inventing its own fallbacks.
 *
 * Values are read at call time (never at module scope) so the same build works
 * in Lovable Preview, local development, Vercel Preview and Vercel Production
 * with configuration supplied by the environment at request time.
 *
 * Never import this from browser code: it resolves the service-role key.
 */

export interface ServerSupabaseConfig {
  url: string;
  serviceRoleKey: string;
  publishableKey: string;
}

export interface ServerSupabaseConfigResult {
  config?: ServerSupabaseConfig;
  /** Names of the environment variables that are missing, in check order. */
  missing: string[];
}

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveServerSupabaseConfig(): ServerSupabaseConfigResult {
  const url = read("SUPABASE_URL") ?? read("VITE_SUPABASE_URL");
  const serviceRoleKey = read("SUPABASE_SERVICE_ROLE_KEY");
  const publishableKey =
    read("SUPABASE_PUBLISHABLE_KEY") ??
    read("SUPABASE_ANON_KEY") ??
    read("VITE_SUPABASE_PUBLISHABLE_KEY");

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!publishableKey) missing.push("SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)");

  if (!url || !serviceRoleKey || !publishableKey) return { missing };

  return { config: { url, serviceRoleKey, publishableKey }, missing };
}

/**
 * Message shown to the caller. It names the missing variables so the failure is
 * actionable, and it never contains any secret value.
 */
export function describeMissingServerSupabaseConfig(missing: string[]): string {
  return `Server Supabase configuration is missing: ${missing.join(", ")}. Set these environment variables for this deployment (server-side only — do not prefix the service role key with VITE_).`;
}
