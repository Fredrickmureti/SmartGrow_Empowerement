# Why you're seeing "multiple invitations" and no email

## What I actually see in the database

For `nkathavictor26@gmail.com` there is exactly **one** invitation row in `organization_invitations` (id `b838056d…`, created 21:05, `accepted_at = null`). Each time you click "Send invitation" the server-side `upsert_organization_invitation` RPC finds that existing pending row and **refreshes it** (extends `expires_at`, keeps the same token) instead of creating a duplicate. That is by design — it's what prevents the "Someone else updated this record" 23505 error we used to hit.

So you are *not* creating multiple invitations. You are re-triggering the send on the same invitation. The toast wording "Invitation refreshed and resent to …" is what's making it feel like new invites keep piling up.

## Why the email never arrives

`platform_email_logs` is empty for this recipient. Not one row — meaning `send-email` was **never actually called**. Every single POST to `send-invitation-email` in the edge-function analytics returned **404** ("Invitation not found").

Root cause (already patched in the previous turn): `send-invitation-email/index.ts` was selecting a column that doesn't exist —

```
.select(`… organization_id, business_id, organization:organizations(id, name)`)
```

`organization_invitations` has no `business_id` column (verified against `information_schema`). PostgREST rejected the query, `invError` was truthy, the handler returned 404 "Invitation not found", and the client toast said "Invitation refreshed and resent" because the invite *row* was upserted successfully — the email step just failed silently.

## What is still wrong even after that patch

Two behaviour bugs remain and explain why you had zero visibility:

1. **The 404 handler swallows the real Postgres error.** `invError.message` is never logged and never returned; it's replaced with the string `"Invitation not found"`. Any future schema drift will look identical to a genuine missing invitation.
2. **The client treats an email-send failure as success.** In `EmployeeInviteDialog.tsx` the `supabase.functions.invoke("send-invitation-email", …)` result is not inspected — `invoke` does **not** throw on non-2xx responses, so a 404/500 from the function slips through the `try/catch` and the toast still says "Invitation sent". That is why you saw success toasts while nothing ever left the platform.

## Plan

### 1. Verify the phantom-column fix actually deployed

Call `send-invitation-email` once with the existing invitation id and confirm it now reaches `send-email` and produces a `platform_email_logs` row with `status='sent'` (or a real Resend error). If it's still 404, the fix didn't roll out and we redeploy.

### 2. Stop silently swallowing errors in `send-invitation-email`

- `console.error("[send-invitation-email] load invite failed", invError)` before the 404 return.
- Return the real reason in the JSON body (`{ error: "invitation_lookup_failed", details: invError.message }`) with the status that matches (`404` only when `data` is null with no error; `500` when `invError` is set).
- Also `console.error` any `sendErr` coming back from `send-email` — right now those are only surfaced as JSON to the caller.

### 3. Make the client surface the real failure

In `EmployeeInviteDialog.tsx`:

- After `invoke("send-invitation-email", …)`, read `error` and, when it's a `FunctionsHttpError`, pull `await error.context.text()` for the real body.
- On email-send failure show `toast.error("Invitation saved but email failed: <reason>")` instead of the current success toast — so the next time this breaks you see it in one click, not five.

### 4. Fix the "multiple invitations" perception

- When `upsert_organization_invitation` returns `status = 'reused'`, change the toast to "Invitation to <email> was already pending — resent the same link." That is what actually happened; there is still only one invite row.
- Show the single pending invitation (with `created_at` and `expires_at`) in the employee sidebar so you can see it hasn't been duplicated.

### 5. Sanity-check the Resend sender

`resend_from_email = support@accrualflow.systems`. If the `accrualflow.systems` domain is verified in Resend, this is fine. If not, Resend will 403 for any recipient other than the workspace owner and we'll see it in `platform_email_logs.error_message` once step 2 is in place. No change needed if the domain is already verified — the point is that after step 2 you'll actually *see* that error instead of guessing.

## Out of scope

- Rewriting the invitation acceptance flow.
- Changing `upsert_organization_invitation` semantics (reuse-and-refresh is correct enterprise behaviour).
- Swapping Resend for another provider.

## Technical details

- Files touched: `supabase/functions/send-invitation-email/index.ts`, `src/components/employees/EmployeeInviteDialog.tsx`. No migrations.
- No DB schema changes; the phantom-column reference is the only remaining artefact and it is already removed in the current file.
- After deploy, verify against `platform_email_logs` (`status`, `error_message`) and edge analytics (POST 200 instead of 404) before declaring it fixed.
