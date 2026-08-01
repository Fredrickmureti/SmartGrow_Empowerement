# Make POS receipt preview and printed output identical

## Confirmed cause

The simulator is not at fault. The POS currently produces the two outputs from different inputs:

- `PostPaymentSurface` prints through `PrintService` → frozen `pos_receipt_snapshots` → `document_records` → `render-document` → ESC/POS bytes.
- Its `PaperPreview` separately calls `buildReceiptLines` with the live transaction, live browser settings, and browser-local time.

For `POS1-260801-0005`, the persisted print snapshot has the correct `two-lines` format and footer, but its cashier is null and its timestamp is the UTC instant `2026-08-01T13:33:55...`. The browser preview instead receives the live cashier and formats that instant in the browser timezone. This directly explains the cashier/time differences and proves the preview is not a preview of the bytes sent to the printer.

## Implementation

1. **Use one frozen receipt record**
   - Resolve/materialize the POS receipt document record once from the frozen sale snapshot.
   - Reuse that same record for preview, print, PDF, and history reprint.
   - Stop rebuilding the post-sale paper preview from `liveSettings` and the live transaction.

2. **Make the paper preview server-authoritative**
   - Render the preview through `render-document` in ESC/POS mode using the same document record and paper-format options as Print.
   - Display a decoded representation of that returned ESC/POS artifact, so the preview reflects the actual title, rows, spacing, footer, feed, and cut sequence.
   - Keep the human-oriented sale summary separate; only the view labelled as paper/receipt preview must be byte-authoritative.

3. **Remove the duplicate POS preview assembly**
   - Delete `PaperPreview`'s local `buildReceiptLines` input construction from `PostPaymentSurface`.
   - Route receipt-history preview through the same server-artifact seam.
   - Preserve the shared `Line[]` engine as the server row producer; do not introduce another receipt formatter.

4. **Correct frozen identity and time data at the source**
   - Ensure the POS snapshot trigger captures the resolved cashier identity needed on the fiscal receipt.
   - Carry the business/branch timezone in the frozen presentation context and make date formatting explicit rather than runtime-local.
   - Existing historical receipts remain immutable; new receipts receive complete frozen metadata.

5. **Deploy and verify the real byte producer**
   - Deploy the updated `render-document` function and shared renderer code used by local printing.
   - Render a fixture matching `POS1-260801-0005`, decode the returned bytes, and assert the configured two-line item layout, footer, title, cashier policy, timestamp, feed, and cut marker.

## Regression protection

- Add an integration test that renders one frozen receipt through both Preview and Print entry points and asserts an identical content hash/byte array.
- Add an architecture guard forbidding POS paper previews from directly assembling `buildReceiptLines` from live transaction/settings.
- Extend snapshot-fidelity coverage for cashier and explicit timezone.
- Verify a fresh sale and a history reprint against the ESC/POS simulator; both previews must match the simulator output line-for-line.

## Technical boundary

```text
Frozen POS snapshot
       ↓
Document record (one ID)
       ↓
render-document / canonical Line[] engine
       ↓
ESC/POS artifact (one hash)
       ├── decoded paper preview
       └── exact bytes sent to simulator/printer
```