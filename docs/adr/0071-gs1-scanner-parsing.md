# ADR 0071 — GS1 barcode parsing on scanner input

- **Status**: Accepted (2026-07-16)
- **Related**: ADR 0025 (lot-aware quants + FEFO), ADR 0066 (downstream
  lot/serial stamping), ADR 0067 (serialised inventory), ADR 0069
  (inbound shipments / ASN)

## Context

The inventory foundation now tracks lot, serial, and expiry per movement
(ADRs 0025 / 0066 / 0067). At capture time, however, operators were
still asked to type these values by hand — a scanner emitted a single
opaque code, resolved it to a product, and lot/serial/expiry followed as
manual entry.

Enterprise-grade suppliers already print this data on the carton in
GS1-128 (linear) or GS1 DataMatrix (2D) format. A single scan of a GS1
label carries GTIN + batch + expiry + serial + quantity, delimited by
Application Identifiers (AIs) and FNC1 group separators.

## Decision

Introduce a **pure** GS1 parser and a thin adapter hook, then wire them
into every capture surface that currently reads a scan.

1. `src/lib/gs1/aiTable.ts` — data-only AI catalogue.
2. `src/lib/gs1/parseGs1.ts` — table-driven parser. Imports only from
   `./aiTable`. Returns `{ ok, elements, normalized }`. Unknown AIs are
   soft-failed so industry-specific extensions don't abort the parse.
3. `src/lib/gs1/useGs1Scanner.ts` — `interpretScan(raw)` returns the
   structured payload plus a `resolveCode` (the GTIN when GS1, else the
   raw code) so downstream barcode resolvers keep working unchanged.
4. Capture surfaces (GRN wizard, `LotPickerPopover`,
   `SerialPickerPopover`, POS scan input) run every scan through
   `interpretScan` first. GS1 payloads pre-fill lot / expiry / serial
   on the target row; non-GS1 payloads follow the legacy path.

### Non-goals

- No schema changes. GS1 is a **capture format**, not a storage format.
- No new RPCs. Downstream persistence still flows through
  `consume_lots_atomic` and the goods-receipt path.
- No POS UX changes in this phase — POS reuses the same interpreter, so
  a GS1 scan on the sales floor resolves to the GTIN and (when the
  product is serial-tracked) surfaces the scanned serial for validation.

## Consequences

- Receiving a GS1-labelled carton is a **single scan**: GTIN → product,
  batch → lot, expiry → lot expiry, serial → per-unit serial.
- Regulated verticals (pharma, medical, FMCG) no longer depend on
  operator diligence to keep lot/expiry aligned with the physical
  carton.
- Parser isolation (import-guard) keeps the AI table auditable — any
  addition of a new AI is a one-file, one-review change.

## Alternatives considered

- **Add a third-party GS1 dependency.** Rejected — the AI grammar is
  small, and every dependency crossing the scanner path becomes a supply
  chain concern. The parser is ~120 lines and fully covered by table
  tests.
- **Only parse on the GRN wizard.** Rejected — LotPicker and
  SerialPicker are the correct place to receive pre-filled context;
  centralising the parser and calling from every surface keeps behaviour
  uniform.
