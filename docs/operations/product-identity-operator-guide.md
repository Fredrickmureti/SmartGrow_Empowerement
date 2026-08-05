# Scanning a product: what each outcome means

Audience: dock supervisors, counters, cashiers, and the inventory admin who
fixes what they report. Behaviour is defined by ADR 0114.

## The rule behind everything

A scan either resolves to exactly one product **at a known packaging level**,
or it is refused. There is no "close enough". A refused scan never posts
stock and never creates a product — refusing is cheaper than a phantom
receipt or a duplicate item master.

## Outcomes you will see

| Message the operator sees | What actually happened | Who fixes it, and how |
| --- | --- | --- |
| Item added / counted | One active identifier matched. The quantity posted is the level's pack size (a case scan posts the whole case). | — |
| "More than one product uses this code" | Two or more active identifiers share the code. The system will not guess. | Inventory admin: open Barcode Enrollment, retire the wrong one. |
| "This code isn't registered yet" | No identifier, no SKU match. | Enroll it against the right product **and the right packaging level** — each is scanned once. |
| "This code is no longer in use" (inactive / archived) | The code existed and was retired. Usually an old supplier label still on stock. | Re-label, or re-issue the code on the correct product. |
| "This code has expired" | The identifier's validity window has passed — typically a seasonal or promotional GTIN. | Extend the validity window or enroll the replacement code. |
| "This code belongs to another supplier" | The code is registered, but scoped to a different vendor. Two vendors legitimately reuse part numbers. | On receiving, this means the wrong document is open. Check the inbound document before anything else. |
| "You don't have access to this product" | The code belongs to another business in the group. | Switch business, or ask an admin to enroll it for yours. |

## Why the dock beeps instead of showing a message

On a handheld the operator is looking at the pallet, not the screen. Any
blocked scan emits an audible and haptic rejection **and** refuses the line.
If you hear the reject tone, nothing was posted — rescan or fix the code.

## Packaging levels are the whole point

Enroll a code against the level it is printed on:

- the each/unit barcode goes on the base level
- the carton label goes on the case level (pack size lives on the level, not
  next to the code)
- the pallet/SSCC label goes on the pallet level

A case code enrolled against the base level is the classic cause of "we
received 1 instead of 24".

## Supplier (vendor) codes

Vendor part numbers are scoped to that vendor, so two suppliers may use the
same number without colliding. Consequences:

1. A supplier code resolves **only** while the matching inbound document is
   open. The vendor is taken from the document — you are never asked to pick
   one, because picking one would let a scan match the wrong catalogue.
2. Unknown code on a receiving line? The system offers **discovery**: likely
   candidates from the open PO lines, that vendor's price list, and codes
   other vendors use for the same item. Linking a candidate records the code
   — it does not post stock. Scan again afterwards; the receipt stays
   evidence-based.
3. Supplier pricelist imports register the "Vendor Product Code" column as a
   supplier-scoped identifier automatically. Rows whose code could not be
   registered are listed in the import result — the price still imported.

## In POS

The cashier path is the same decision, one round trip. A blocked scan does
not add a line. Weighted and price-embedded barcodes are still interpreted
(price and weight come from the barcode, identity from the resolver).
