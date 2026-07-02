# Overlay components (Dialog / Sheet / AlertDialog / Drawer / Popover)

## The rule: always mount, toggle via `open`

```tsx
// ✅ CORRECT
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>…</DialogContent>
</Dialog>

// ❌ WRONG — causes app-wide click freeze
{isOpen && (
  <Dialog open onOpenChange={setIsOpen}>
    <DialogContent>…</DialogContent>
  </Dialog>
)}
```

## Why

Radix sets `pointer-events: none` on `<body>` when an overlay opens (its
scroll-lock implementation) and removes it when the overlay closes
*through its own internal lifecycle*. If the overlay is unmounted while
still `open` — which happens when the gating condition flips to falsy or
when a parent route unmounts — Radix never gets to run its cleanup and
`<body>` is left dead. The page still scrolls (scroll is not gated by
`pointer-events`) but no buttons, links, tabs, menus, or inputs respond
to clicks anywhere in the app.

We have a defensive recovery net (`BodyPointerEventsGuard`) that clears
this stuck style, but **prevention is the rule, not recovery**.

## Sub-rules

1. **Never render an overlay inside `cond && <Dialog>`.** Mount it once;
   pass the condition to `open=`.
2. **Never `navigate(...)` from inside an open overlay** without first
   calling `onOpenChange(false)`. If you must navigate immediately,
   defer the navigation: `setOpen(false); setTimeout(() => navigate(...), 0)`.
3. **Never conditionally render the overlay's *parent route* while the
   overlay is open.** Close the overlay first, then let the route change.
4. **Toast viewports must keep `pointer-events-none`.** The empty viewport
   sits at `z-100` and will eat clicks across the right column / mobile
   screen if it is interactive. Toasts themselves get `pointer-events-auto`
   via `toastVariants`.

## Enforcement

- Lint rule: `local/no-conditional-radix-overlay` (errors on `cond && <Dialog>`).
  Use `// OVERLAY-EXEMPT: <reason>` to opt out.
- Architecture test: `src/test/architecture/no-conditional-radix-overlay.test.ts`
  scans the entire `src/` tree.
- Architecture test: `src/test/architecture/toast-viewport-pointer-events.test.tsx`
  pins the toast viewport CSS.
- Runtime guard: `src/components/common/BodyPointerEventsGuard.tsx` is
  mounted in `AuthenticatedShell` and clears any stuck
  `pointer-events: none` on `<body>` when no overlay is open.
