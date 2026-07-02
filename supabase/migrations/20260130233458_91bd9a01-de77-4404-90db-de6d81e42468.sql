-- Add completion_message column to signature_requests table
-- This allows users to customize the message recipients receive after signing

ALTER TABLE public.signature_requests
ADD COLUMN IF NOT EXISTS completion_message TEXT;