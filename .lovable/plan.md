# Passport photo capture at loan disbursement

## Current state (verified)

- Every client already carries a passport photo and identity images captured at registration. All 10 live clients have both a photo and an ID front image on file. They live in the private `mf-kyc` store, filed per institution and client, and are shown only through short-lived signed links.
- Registration already has a working in-app camera (take a photo or pick one from the device, auto-resized before upload).
- Disbursement today asks only for value date, method, reference, "received by" name and notes. It never shows the client's photo and never captures one. The payout record keeps no image at all.
- The payout itself is fully server-controlled: it checks institution access, role (admin, branch manager, cashier), that the loan is awaiting disbursement, that it hasn't already been paid, and that the amount equals the approved principal, then posts the accounting entries. None of that is touched by this change.

## Gap

There is no evidence of the person who actually collected the cash. The only identity evidence is the registration photo taken earlier, and the disbursing officer never even sees it.

## What will be built

A fresh photo taken at the payout desk, attached to that specific disbursement.

1. **In the Disburse dialog**: the client's registration photo is shown side by side with a new "Photo at payout" slot using the same camera the registration screen uses. Officer takes the photo of the client collecting the money.
2. **Warn, never block**: if no photo is taken, a clear warning appears and the confirm button changes to "Disburse without photo". The payout still goes through — no cash operation is ever stopped by this.
3. **Storage**: the photo goes into the existing private KYC store under the loan's own folder, keyed to the disbursement record. Same visibility rules as existing KYC images — no new bucket, no public access.
4. **Persistence**: the payout record gains one field holding the photo's location. It is written only by a guarded server routine, only for a payout that has no photo yet and is not reversed, and only by someone allowed to disburse. Once set it cannot be silently swapped.
5. **Where it shows afterwards**: the loan's disbursement details show the payout photo alongside the registration photo, so a reviewer can compare them later.

## Financial safety

Nothing in the amount, fees, schedule, accounting entries or status transitions changes. The photo is written after the payout succeeds, in a separate step; if the photo upload fails, the disbursement stands and the officer is told the photo did not attach and can retry attaching it.

## Technical notes

- Migration 1: `ALTER TABLE public.mf_loan_disbursements ADD COLUMN payout_photo_path text` (nullable, additive; no data touched).
- Migration 2: `public.mf_attach_disbursement_photo(p_disbursement_id uuid, p_path text)` — SECURITY DEFINER, mirrors the role/business checks in `mf_disburse_loan`, rejects a reversed row or one that already has a path, validates the path is under `<business_id>/<loan_id>/`, writes an `mf_loan_events` entry (`disbursement_photo_attached`) for audit. No accounting hook.
- Migration 3: storage policies on `storage.objects` for the `mf-kyc` bucket allowing insert/select of `disbursements/<business_id>/...` objects by users with business access and the disburse roles — modelled on the existing client KYC object policies, not replacing them.
- Frontend: reuse `CameraCaptureDialog` + the image-normalising helper from `KycCaptureField`; add a compact capture block to `DisburseDialog.tsx`; extend `useMfLoans` disburse mutation with an optional blob → upload → `mf_attach_disbursement_photo`; extend the loan/disbursement type and select list.
- `mf_disburse_loan` is not modified.

## Verification

- Disburse a test loan with a photo: confirm the row carries the path, the object exists, the signed link renders, and the ledger entries are identical in shape to an existing disbursement.
- Disburse without a photo: warning shown, payout succeeds, path stays empty.
- Attempt to attach a photo to an already-photographed or reversed payout, and as a user without the disburse role: both refused by the server.
- Confirm existing loans and disbursements are unchanged and the new column is empty for them.


==================IMPLEMENTATION STATUS===============
Complete (pending a signed-in UI walkthrough).

Verified in place from the earlier session
- Payout photo field on the payout record (all existing payout records unaffected; none carry a photo).
- Guarded server routine attaching the photo: institution access, disburse roles only, refuses a reversed payout or one already photographed, path must sit under that loan, writes a loan-history entry. Money, fees, schedule, accounting untouched.
- Private-store access rules for payout photos (insert by disbursing staff, view by anyone who can read the loan).
- Disburse screen capture block, warning and "Disburse without photo" button.

Finished in this session
- The Disburse screen was never actually given the client's registration photo or name; both are now passed in, so the comparison photo appears.
- New read-only "Payout identity evidence" panel showing the registration photo beside the payout photo; it appears in the loan details (schedule) view for disbursed loans, with a note when no photo was taken.

Verification done
- Server routine reviewed line by line; guards confirmed. The only trigger on the payout table fires on creation only, so attaching a photo cannot disturb it.
- Storage access rules confirmed present and scoped to the loan.
- Existing data confirmed untouched: there are no payout records at all yet, so nothing historic changed.
- Build and type checks pass on the changed screens.

Remaining uncertainty
- No signed-in UI walkthrough was possible: this workspace connects to an external Supabase project, so a test session cannot be created here. A staff member should open a pending loan, take a payout photo, disburse, and confirm the photo appears in the loan details afterwards.
