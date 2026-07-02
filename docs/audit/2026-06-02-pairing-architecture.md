# Phone-Pairing Architecture — Zero-Trust Audit

Date: 2026-06-02
Scope: End-to-end audit of QR-based phone pairing across POS, Inventory,
Sales, Products, Goods Receipt, Stock Transfer, Physical Count surfaces.

## TL;DR

Pairing IS implemented correctly. The reported "phone just opens the
website" symptom is NOT a defect in QR generation, session creation,
RPCs, RLS, or realtime channels — those are all verified working. The
real root causes are two host-/router-layer flaws:

1. **`tryGetPublicAppUrl()` prefers `VITE_PUBLIC_APP_URL` over
   `window.location.origin`.** `.env` pins this to
   `http://accrualflow.systems`. When the desk is running on a Lovable
   preview host or any deployment that is NOT accrualflow.systems, the
   QR encodes a URL pointing to a *different host* than the desk. The
   phone lands on a deployment where it is not logged in, the
   `MobileScannerPage` auth gate redirects to `/login`, and the operator
   sees "phone redirected to the website."
2. **The TanStack route tree has no `/pos/scan/$token` route.**
   `src/routes/` contains only `__root.tsx` and `index.tsx`. When the
   published deployment is served via TanStack Start SSR (as configured
   by `src/router.tsx` and the Vite Start plugin), `/pos/scan/<token>`
   is unmatched and renders `__root.tsx`'s `notFoundComponent` ("404
   Page Not Found"). The SPA-side route declared in `src/apps/pos/routes.tsx`
   only resolves under the `main.tsx` → `App.tsx` client-only path, not
   under SSR.

Issue A from the report ("QR codes all point to `/pos`") is BY DESIGN —
the scanner architecture is workspace-scoped (one shared session across
modules), so all QRs intentionally encode `${base}/pos/scan/<token>`.
Module context lives in the **token**, not the URL. This matches Shopify
POS, Square POS, and similar mature systems.

## Intended architecture (verified)

```text
ScannerWorkspaceProvider (src/contexts/ScannerWorkspaceContext.tsx)
  mounted once in AuthenticatedShell (src/components/auth/AuthenticatedShell.tsx)
  owns ONE scanner_session per (businessId, branchId)
        │
        ├── useScannerSession (src/hooks/scanner/useScannerSession.ts)
        │     - RPC create_scanner_session
        │     - RPC create_scanner_session_pairing (60s single-use token)
        │     - useScanChannel → supabase.channel("scan:session:<id>", { private: true })
        │
        └── ScannerSessionDialog (src/components/scanner/ScannerSessionDialog.tsx)
              - renders QR: ${tryGetPublicAppUrl()}/pos/scan/<token>
              - shows live presence + RTT + last-scan when paired
                │
       QR scanned by phone
                ▼
        MobileScannerPage (src/pages/pos/MobileScannerPage.tsx)
          mounted at /pos/scan/:token (SPA: src/apps/pos/routes.tsx#119)
            1. supabase.auth.getSession() — must be authed
            2. RPC pos_claim_scanner_pairing OR claim_scanner_session_pairing
            3. RPC scanner_issue_trust → localStorage trust token (30d)
            4. supabase.channel(channel_key, { presence, private }).subscribe
            5. BarcodeDetector / ZXing / native scanner →
               broadcast { code, seq, decoded_at }
                │
        Desk-side BarcodeInputField + scanBus + scanRouter consume the
        broadcast and dispatch the scan to the currently focused field.
```

## Phase-by-phase findings

| Phase | Finding | Evidence | Class |
|---|---|---|---|
| 1 Architecture | Workspace-scoped pairing model is sound and documented in ADR-0013 | `docs/adr/0013-scanner-as-erp-input-infrastructure.md`, `mem/features/pos-phone-scanner.md` | VERIFIED WORKING |
| 2 QR generation | All QRs encode `${PUBLIC_APP_URL}/pos/scan/<token>`. Module context lives in `scanner_session.target_kind`, not the URL | `src/hooks/scanner/useScannerSession.ts:176`, `src/components/scanner/ScannerSessionDialog.tsx:284` | VERIFIED WORKING |
| 3 Pairing session | Session row + 60s single-use token + trust mint all wired; RLS RESTRICTIVE-deny + SECURITY DEFINER RPCs | `supabase/tests/scanner_session_rls_test.sql`, RPCs `create_scanner_session*`, `pos_create_scanner_pairing` | VERIFIED WORKING |
| 4 Scan flow | Auth gate on phone redirects to `/login` when not signed in on the QR's host. Combined with host mismatch (root cause 1) this produces the observed symptom | `src/pages/pos/MobileScannerPage.tsx:246-405, 940` | PARTIALLY IMPLEMENTED |
| 5 Mobile device | Device id persisted in `localStorage`, trust token rotated on successful claim, silent reclaim on refresh | `src/services/scanner/deviceIdentity.ts`, `MobileScannerPage.tsx:279-309` | VERIFIED WORKING |
| 6 Module isolation | `target_kind` enforced server-side; phone tries POS RPC first then session RPC. No cross-module leak possible — tokens are uniquely scoped to one session row | `MobileScannerPage.tsx:330-368` | VERIFIED WORKING (minor UX: error messages can be misleading when wrong RPC is tried first) |
| 7 Enterprise comparison | Workspace-scoped one-device-many-screens matches Shopify POS scanner, Square Stand Mobile, Lightspeed Scanner. Per-module sessions would be a regression | n/a (research) | VERIFIED WORKING |
| 8 Security | Tokens hashed sha256 server-side, 30d trust window, RESTRICTIVE RLS, private realtime channel with `can_access_pos_scan_channel` policy | `docs/audit/2026-05-22-scanner-p4b-device-trust.md`, `supabase/tests/scanner_session_rls_test.sql` | VERIFIED WORKING |
| 9 UX | No "QR host ≠ desk host" warning; silent `navigate("/pos/scan", { replace: true })` (line 377) can strand the user on a tokenless URL after a partial failure | `MobileScannerPage.tsx:377` | UX DEFECT |
| Routing | TanStack route tree (`src/routes/`) does not mirror `/pos/scan/$token`. Under TanStack SSR the phone hits `__root.tsx#notFoundComponent` | `src/routes/__root.tsx:30-34`, `src/routes/index.tsx` (renders "backend only" placeholder) | ARCHITECTURAL FLAW |
| Host | `tryGetPublicAppUrl()` prefers env (`accrualflow.systems`) over `window.location.origin` | `src/lib/publicAppUrl.ts:73-96`, `.env: VITE_PUBLIC_APP_URL` | ARCHITECTURAL FLAW |

## Root cause summary

The pairing architecture is not broken. The QR codes are not wrong.
The RPCs, RLS, and channels are not bypassed. The phone IS becoming a
real paired device when it can complete the claim — but it cannot
complete the claim when:

- the QR points to a host the phone reaches but the desk does not
  share a Supabase session with (host-mismatch), OR
- the QR's URL hits a TanStack SSR deployment that has no route for
  `/pos/scan/$token` (router-mismatch).

Both manifest as "I scanned and got dumped on the website."

## Fixes shipped in this slice

See `.lovable/plan.md` (approved 2026-06-02). Stages 0–2 and 4 ship in
this commit. Stage 3 (phone-side gating of post-claim navigation) is
queued separately.
