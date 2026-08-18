# Architecture Decision Records (ADRs)

ADRs are short, dated records that capture an architectural decision, the
context that forced it, and the consequences (both accepted and sacrificed).
They are immutable: once accepted, an ADR is never edited — it is
**superseded** by a newer ADR that explicitly references it.

## Why ADRs exist in this project

The Inventory architecture audit (Phases 1–3) implemented the must-fix
correctness work. Phase 4 captures the **deliberate deferrals** — features
that exist in Odoo and similar ERPs but that we have explicitly chosen
*not* to implement in v1. Without ADRs, a future contributor reading the
schema will assume these gaps are bugs and may "fix" them in a way that
breaks the deliberately-simple model.

## Index

| #    | Title                                                           | Status   |
| ---- | --------------------------------------------------------------- | -------- |
| 0001 | [v1 inventory has no per-lot quants](./0001-no-per-lot-quants-v1.md)              | Accepted |
| 0002 | [Single costing method: AVCO on receipt, snapshot on sale](./0002-costing-method-avco-on-receipt.md) | Accepted |
| 0003 | [React Router DOM is the de-facto router](./0003-react-router-dom-de-facto.md)    | Accepted |
| 0114 | [Product identity and resolution](./0114-product-identity-and-resolution.md)       | Accepted |

> The index above is partial — the directory listing is authoritative.

## Numbering hygiene

Numbers were allocated concurrently and collided: **0102** is used by three
ADRs, **0110** by two, and **0141** / **0142** each by two (a Banking pair and
a Supplier-purchasing pair, written in parallel waves). Those files are left as
they are — an accepted ADR is immutable, and renaming one silently breaks every
citation of it in code comments, tests and memory files. The numbers are burnt:
never reuse them, cite a collided ADR by number *and* title, and always allocate
the next number by listing `docs/adr/` rather than by memory. The highest
allocated number is **0145**.

Collided numbers, disambiguated by title:

| #    | Files |
| ---- | ----- |
| 0141 | [A bank balance is derived, never stored](./0141-bank-cash-position-is-derived-never-stored.md) · [Purchasing terms belong to the supplier-product relationship](./0141-supplier-owned-purchasing-terms.md) |
| 0142 | [Single balance: availability vs reservation](./0142-inventory-single-balance-availability-reservation.md) · [Supplier purchasing conditions](./0142-supplier-purchasing-conditions.md) |

## Format

Each ADR follows this structure:

- **Status** — Proposed / Accepted / Superseded
- **Context** — what forces the decision
- **Decision** — what we chose
- **Consequences** — accepted, sacrificed, risks
- **Alternatives considered** — what we rejected and why

## When to write a new ADR

Write an ADR when a decision is:

1. **Hard to reverse** (schema choices, costing methods, multi-tenancy
   boundaries).
2. **Cross-cutting** (affects more than one module — Inventory + POS +
   Finance).
3. **Counterintuitive** (we deliberately do *not* do the obvious thing).

Do **not** write an ADR for:

- Implementation details inside a single module
- Coding conventions (those go in the project README or CONTRIBUTING)
- Bug fixes (those go in commit messages and migration descriptions)
