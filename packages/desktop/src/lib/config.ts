/**
 * Runtime configuration for the desktop shell.
 *
 * The Supabase project is *tenant-shared* — every AccrualFlow customer's
 * Edge Desktop talks to the same public gateway URL and uses the anon key
 * (which is safe to embed by design; RLS + workstation secrets do the
 * actual access control).
 *
 * These constants can be overridden at packaging time via Vite `define` if
 * we ever fork a private-cloud build.
 */
export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  'https://jkszmrroyjfdwokbkzis.supabase.co';

export const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';
