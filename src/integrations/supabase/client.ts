// Browser Supabase client for the Microfinance system.
//
// SAFETY: this must NEVER point at the AccrualFlow reference project.
// The URL/key are read from the environment first and fall back to the
// Microfinance project's published values.
//
// TYPING NOTE (reconstruction phase): the generated `Database` type only
// covers the tables that have been re-created in the new project so far.
// The schema is being rebuilt in ordered baseline steps, so the client is
// intentionally untyped until the reconstruction finishes — otherwise every
// not-yet-created table breaks the typecheck. Re-introduce
// `createClient<Database>` once the baselines are complete.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { brokeredPreviewStorage } from './previewAuthStorage';

const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://xwxqunklduknceoryrha.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eHF1bmtsZHVrbmNlb3J5cmhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4Nzc4MzcsImV4cCI6MjEwMzQ1MzgzN30.6zYTXR-rdy8XJ2wPgxgYHTIQj-BpvDrf03H98kTYfVM';

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase: SupabaseClient<any, 'public', any> = createClient<any>(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);
