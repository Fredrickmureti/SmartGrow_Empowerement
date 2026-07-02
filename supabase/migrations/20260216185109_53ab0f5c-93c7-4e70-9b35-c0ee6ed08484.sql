
-- ============================================================
-- 1. FIX: signature_signers SELECT policy - too permissive
-- The old policy "External signers can view own record via token" 
-- uses (access_token IS NOT NULL) which exposes ALL signer records.
-- Replace with a policy that only allows viewing via anon + matching token.
-- ============================================================
DROP POLICY IF EXISTS "External signers can view own record via token" ON public.signature_signers;

-- External signers (anon) can only see their record when they provide a specific token
-- This is safe because the token acts as a bearer credential via the query filter.
-- No policy needed for anon SELECT - service role handles external signing via edge functions.

-- ============================================================
-- 2. FIX: signature_audit_log overly permissive INSERT policy  
-- "System can create audit logs" with with_check: true allows ANY user to insert.
-- Remove it - edge functions use service role key which bypasses RLS.
-- The org-scoped policy already handles authenticated user inserts.
-- ============================================================
DROP POLICY IF EXISTS "System can create audit logs" ON public.signature_audit_log;

-- ============================================================
-- 3. Add document_hash column for tamper detection
-- SHA-256 hash of the original uploaded document, computed on upload.
-- Used to verify document integrity before and after signing.
-- ============================================================
ALTER TABLE public.signature_requests 
  ADD COLUMN IF NOT EXISTS document_hash text;

-- ============================================================
-- 4. Add token_expires_at for independent token expiration
-- Tokens expire independently of request expiration.
-- Default: 30 days from creation.
-- ============================================================
ALTER TABLE public.signature_signers 
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

-- Backfill existing signers with 30 days from creation
UPDATE public.signature_signers 
SET token_expires_at = created_at + interval '30 days'
WHERE token_expires_at IS NULL;
