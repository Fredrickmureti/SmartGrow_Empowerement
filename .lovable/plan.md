# POS Tender Page Redesign

Fix the overflow, cluttered layout, and always-visible fields on the payment page. Cover the tender workspace, keypad component, and the Card / M-Pesa sub-modals.

## Problems today

- Left column stacks method chips → amount display → quick chips → reference → tip → rounding note → keypad → Add Tender button in a fixed vertical order. On typical laptop heights (~700–800px CSS) the keypad's 4 rows of 80–96px keys plus the Clear bar push content off-screen.
- All optional fields (tip, quick chips, reference) render regardless of whether they apply to the selected method.
- Custom-built `NumericKeypad` uses `h-20 sm:h-24` fixed heights; it does not shrink to fit its container, which is what causes the overflow.
- Card and M-Pesa sub-modals use their own layouts and don't share the same keypad, so the experience feels inconsistent.

## Redesign

### 1. Layout reorganization (left surface)

Switch the left surface from a fixed vertical stack to a **two-region flex layout** that always fits the viewport:

```text
┌───────────────────────────────────────────┐
│ Header (Back • Payment • Amount Due)      │
├───────────────┬───────────────────────────┤
│ Methods (chip │ Right rail                │
│  row, wraps)  │  • Customer               │
│               │  • Cart totals            │
│ Amount card   │  • Paid / Draft /         │
│  (large, live │    Remaining / Change     │
│   change hint)│  • Recorded tenders       │
│               │  • Confirm (sticky)       │
│ Context block │                           │
│  (reference / │                           │
│   tip / chips │                           │
│   — only when │                           │
│   applicable) │                           │
│               │                           │
│ Keypad        │                           │
│  (fills       │                           │
│   remaining   │                           │
│   space, keys │                           │
│   scale via   │                           │
│   aspect-1)   │                           │
│               │                           │
│ Add Tender    │                           │
└───────────────┴───────────────────────────┘
```

Key rules:
- Left surface uses `flex flex-col min-h-0`; the keypad region uses `flex-1 min-h-0` so it always occupies leftover height instead of pushing content off-screen.
- Keypad keys use `aspect-square` inside a `grid-cols-3 gap-2` container, so keys shrink together as the viewport shrinks — no more fixed 96px rows.
- On `<md` (tablet / phone), the right rail collapses into a bottom sheet triggered by a "Details" chip in the header, and Confirm becomes a full-width sticky bar at the bottom.
- Header collapses to one line on mobile (Amount Due moves under the title).

### 2. Swap `NumericKeypad` for `react-simple-keyboard`

- Install `react-simple-keyboard` and use its numeric layout.
- Wrap it in a new `POSKeypad` component that owns the theming and exposes the same `{ value, onChange, onClear, onBackspace }` API as today, so callers don't change.
- Theme via a scoped CSS file (`pos-keypad.css`) that maps `.hg-button` to our design tokens (`--primary`, `--muted`, `--border`, radii, shadows). Buttons scale with container width, not fixed px.
- Add "00" / "." / "⌫" / "Clear" keys as custom buttons in the layout string.
- Reuse `POSKeypad` inside the Card and M-Pesa sub-modals so the amount-entry surface is identical everywhere.

### 3. Context-aware field visibility

Only render each optional block when it's relevant:

| block                | shown when |
| -------------------- | ---------- |
| Reference input      | `selectedMethodConfig.requires_reference` (already correct — keep) |
| Tip row              | `onTipChange` is wired AND register has tips enabled |
| Cash rounding note   | cash method selected AND `cashRoundingDiff !== 0` (already correct — keep) |
| Quick-amount chips   | selected tender is cash (chips exist to round up cash tenders — hide for card/wallet where exact amount is used) |
| "Look up M-Pesa"     | M-Pesa method is selected (move out of the always-visible header row) |
| Change hint          | cash AND tendered > remaining (already correct — keep) |

The "Context block" region between the amount card and the keypad renders whichever of the above blocks apply, or nothing at all when none apply — freeing that vertical space for the keypad.

### 4. Card and M-Pesa sub-modals

- Replace their custom amount inputs with the same `POSKeypad` component.
- Apply the same responsive shell: `flex flex-col`, keypad in `flex-1 min-h-0`, sticky primary action at the bottom.
- Keep all existing driver logic and callbacks unchanged — this is a presentation change only.

### 5. Mobile / tablet breakpoints

- `<sm` (≤640px): single column, right rail becomes a bottom sheet, Confirm is a sticky footer button, keypad keys shrink via `aspect-square`.
- `sm–md` (641–1023px): two columns but rail narrows to 18rem; method chips wrap to two rows if needed.
- `md+` (≥1024px): current two-column layout with `w-80` / `xl:w-96` rail.

## Technical details

Files touched:
- `src/apps/pos/terminal/tender/TenderWorkspace.tsx` — layout restructure and context-aware conditionals.
- `src/components/pos/POSKeypad.tsx` (new) — wraps `react-simple-keyboard`, owns theming, exports the same props NumericKeypad exposed.
- `src/components/pos/pos-keypad.css` (new) — scoped theme overrides mapping `.hg-*` classes to design tokens.
- `src/components/pos/NumericKeypad.tsx` — becomes a thin re-export of `POSKeypad` so any other caller keeps working; deprecation comment added.
- `src/components/pos/CardPaymentModal.tsx` — swap amount entry to `POSKeypad`, apply responsive shell.
- `src/components/pos/MpesaPaymentModal.tsx` — same.

Dependencies:
- Add `react-simple-keyboard` (~40KB gzipped). No peer conflicts with React 19 (library is React-compatible via `preact-compat`-free build).

Not changed:
- Payment session model, RPCs, `resolvePaymentMethods`, tender persistence — the four-axis payment row (ADR 0009) and event model stay intact.
- `TransactionSummaryRail`, the confirm/commit flow, and all driver callbacks.

Verification:
- Build passes typecheck.
- Manual check via Playwright at 1280×720 (typical laptop), 1024×768 (small laptop), 768×1024 (tablet), 390×844 (mobile) — no overflow, keypad always visible, Confirm always reachable.
- Existing `src/__tests__/architecture.pos-workspace-dialogs.test.ts` still passes.
