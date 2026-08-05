# ADR 0017 — Universal Product Acquisition Infrastructure

Status: Accepted (2026-05-21)

> **Superseded in part by [ADR 0114](./0114-product-identity-and-resolution.md)** (2026-08-05):
> the decision envelope, the single read/write client seams, supplier-scoped
> identifiers and the authenticated-only identity surface replace the
> resolution rules described below. The transport/labelling rules that ADR
> 0114 does not restate remain in force.


## Context

Scanner kernel, router, resolver, and BarcodeInputField were all built
during POS work and live under `src/services/pos/*` and `src/hooks/pos/*`.
The path prefix made the platform look POS-specific, so Sales had no
scanner support and three Inventory modules used a `length >= 4` heuristic
inside `BarcodeInputField.onChange` to dispatch scans — which fires on any
4-character paste.

## Decision

Promote the existing kernel to a named, repo-wide platform: *Universal
Product Acquisition Infrastructure*. Three layers, one switch.

```
 Adapter ─┐
 phone    ├─► scanBus ─► scanRouter ─► useResolveBarcode ─► module reaction
 wedge    │   (dedupe)   (focus,         (RPC, LRU,           (qty++ /
 native   │              workflow tag)    single-flight)       count++ /
 camera ──┘                                                    add line)
```

- Canonical imports: `@/services/scanner/*`, `@/hooks/scanner/*`.
- Legacy paths `@/services/pos/*` and `@/hooks/pos/*` re-export the same
  modules for back-compat (POS terminal still imports from them).
- Workflow tag is the only per-module switch: `identity | quantity |
  count | receive`.
- One shared merge helper `applyScanToLines` replaces hand-rolled
  "merge or append" loops in every consumer.
- `BarcodeInputField` exposes `onScan` for router-confirmed scans —
  consumers no longer key on string length.

## Consequences

- New module = pick a workflow tag, mount `<BarcodeInputField>`, pass
  `onScan`, call `applyScanToLines` in the handler. No new transports,
  no new RPCs, no new dedupe.
- Sales/Invoice creation gains scan-first line entry via
  `<InvoiceLineScanner>` without touching POS code.
- `length >= 4` heuristic removed from Physical Count, Stock Transfers,
  Goods Receipt — typing search terms no longer fires spurious scans.

## Out of scope

- Renaming `pos_resolve_barcode` SQL RPC (functionally universal; alias
  works).
- Touching the POS terminal cart consumer.