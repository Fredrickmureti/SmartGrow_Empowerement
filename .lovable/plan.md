# Mobile Sales Scanning — diagnosis and a Scan Session workspace

## What I actually verified in the code

1. **The "Scanner lookup failed / An unexpected error occurred" toast has exactly one source**: `src/contexts/SalesScanContext.tsx:318`, the `kind === "error"` branch of `handleScan`. It is *not* a stray lookup happening "inside the invoice context" — it is the Sales workspace scan target (priority 5, `intent: "doc_author"`) resolving the scanned code, which is correct behaviour. Two real defects around it:
   - The toast prints `normalizeError(...)` output, which buckets anything unrecognised into "An unexpected error occurred" — no code, no raw cause, no retry. So the message is unusable for you *and* for me. Root cause of the underlying failure is **not yet confirmed** (this project's Supabase is external/unmanaged, so I cannot call `pos_resolve_scan` as a signed-in user from here). Confirming it is step 1 below, not a guess.
   - The failure is only announced when **no draft controller is registered and mode is `browse`**. Inside an open invoice draft, both `miss` and `error` are **silent** — no toast, nothing on screen.

2. **That silence is the autofill bug you are seeing.** `LocalScanOverlay.onDecode` calls `scanRouter.wasConsumed(event)` and, on `true`, plays the success beep, paints a green hit, and closes the camera after 120 ms. `wasConsumed` means *"a target received the keystroke"* — it says nothing about whether the barcode resolved to a product. So the viewfinder confidently confirms a scan, closes, and the resolution that happens afterwards can fail (or not match any product) with zero feedback. Current tenant data: **2 products, 3 active identifiers** — most codes scanned will legitimately not resolve, and today that looks identical to success.

3. **Two scan entry points fight in the invoice dialog.** `BarcodeInputField` registers at priority 10 while focused *or* while its own camera button is open, and resolves scans itself via `InvoiceLineScanner.handleManualScan`. `SalesScanContext` registers at priority 5 and resolves via the draft controller. `InvoiceLineScanner` also renders a *second*, standalone camera button. Which of the two paths handles a camera decode depends on which button was tapped and whether focus survived — that is why "focus the field, then tap scan" behaves differently from just tapping scan.

4. **The draft controller re-registers on every render.** `InvoiceCreatePage.tsx:239` declares `handleScanResolved` as a plain function (not `useCallback`), and `useScanTarget`'s effect depends on `onScan` identity, so both the controller and the workspace target churn. The `initialScan` effect at line 276 also closes over a stale `handleScanResolved`.

5. **Nothing in the current design shows a running count.** The overlay keeps at most 6 raw code chips and no product identity, quantity, price, or total.

## Where I'd push back on the brief

- "It shouldn't look up a product while I'm in the invoice context" — it should; resolving the code is the whole job. The wrong part is that the lookup's *outcome* is invisible inside a draft and shouts a meaningless error outside one.
- Trying to make the existing focus-gated field the scanning surface on a phone is a dead end. On a handheld, the camera **is** the input device; a text input that must hold DOM focus while a full-screen viewfinder is up is the wrong model. The fix is a dedicated scan-session surface, not more focus repair.

## Plan

### Phase 1 — Make failure legible (prerequisite, no UX change)
- `useResolveBarcode`: carry the real Postgres/PostgREST error (code + message) on the `error` result instead of collapsing it.
- `SalesScanContext`: announce every non-hit outcome regardless of mode/controller — `not_found`, `ambiguous`, `foreign_tenant`, hard error — with the code that was scanned and the concrete reason, plus a "Retry" action on hard errors. Keep the existing inbox/replay policy untouched.
- `LocalScanOverlay`: stop treating `wasConsumed` as success. Wait for a business outcome on `scanFeedbackBus` (short timeout) before beeping/painting green; route-only acceptance renders as "sent, awaiting match".
- Then reproduce on the phone: the toast will now name the true cause, and I fix that cause (RPC, tenant gate, missing identifier, or client guard) as Phase 1b.

### Phase 2 — One scan path in the invoice draft
- `useCallback` on `InvoiceCreatePage.handleScanResolved`; fix the `initialScan` effect to use a ref so it can't fire stale.
- `SalesScanContext`'s `onScan` gets a stable identity so the priority-5 target stops re-registering.
- Remove the duplicate camera affordance: inside `InvoiceLineScanner`, the field stays a *manual typing* surface only, and the camera always routes through the workspace controller. One resolve path, one merge call (`applyScanToLines`).

### Phase 3 — Scan Session: the immersive surface (the real ask)
A new full-screen route for handheld operators, opened from the Sales workspace chip and from the invoice draft ("Scan mode"):

```text
┌──────────────────────────────┐
│ viewfinder (top 45%)         │  live camera, torch, reticle
│  ┌ last hit card ─────────┐  │  product name, SKU, unit,
│  │ Coca-Cola 500ml   x3   │  │  price, level (each/case),
│  │ KES 180  · case ×12    │  │  stock-on-hand badge
│  └────────────────────────┘  │
├──────────────────────────────┤
│ 4 lines · 17 units           │  running tally, always visible
│ ▸ Coca-Cola 500ml   3  540   │  newest first, tap = qty stepper,
│ ▸ Bread 400g        2  120   │  swipe = remove, long-press = lot
│ ...                          │
├──────────────────────────────┤
│  Undo   Total KES 1,240      │
│  [ Add to invoice ]          │
└──────────────────────────────┘
```

Behaviour that makes it better than Odoo/Shopify handheld:
- **Continuous by default.** Camera never closes between hits; every decode animates a card into the tally. Distinct tones + haptics for hit / duplicate-merge / unknown / blocked.
- **Truthful states.** Four visible outcomes per scan: matched, merged (already on the list → quantity increments, row flashes), unknown code, blocked (ambiguous / wrong tenant / inactive). Unknown codes are queued, not lost, with a one-tap "enrol this barcode to a product" path into the existing enrollment queue.
- **Level-aware quantities.** A case scan adds `qty_in_base_uom` base units and the card says so — reusing `scanToBaseUnits`, no new maths.
- **Immediate correction without leaving the viewfinder**: per-row stepper, undo last scan, and a shake-to-undo affordance.
- **Session survives interruptions** — the tally is persisted per business/user, so backgrounding the phone or a dropped connection doesn't lose a picked cart; on commit it hands one batch of resolved lines to the invoice draft through the existing controller.
- Nothing about POS, warehouse, pairing, or the wedge path changes; this adds a *surface* over the existing kernel, exactly as ADR 0107 requires (one camera engine, one bus, one router).

### Phase 4 — Guards
- Test that `LocalScanOverlay` never reports success from `wasConsumed` alone.
- Test that the invoice draft has exactly one registered resolve path per scan (no double-apply).
- Tests for the Scan Session reducer: merge, undo, level conversion, unknown queueing.

## Technical notes
Touched: `src/contexts/SalesScanContext.tsx`, `src/hooks/pos/useResolveBarcode.ts`, `src/components/scanner/LocalScanOverlay.tsx`, `src/components/invoices/InvoiceLineScanner.tsx`, `src/features/sales/invoices/InvoiceCreatePage.tsx`, `src/components/sales/SalesScanChip.tsx`, plus a new `src/features/sales/scan-session/*` (pure reducer + surface) and tests under `src/test/scanner/`. No schema changes, no new RPCs, no new camera engine, no changes to POS semantics.
