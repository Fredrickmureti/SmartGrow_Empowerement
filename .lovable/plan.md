No — based on the current code, Sales is still not resolved the same way as Product Labels.

**What Product Labels use now**
- `/inventory-app/products` calls `printLabelByTemplate(...)` directly from `src/pages/Products.tsx`.
- That resolves the label template + workflow printer, then calls `hardwareClient.exec({ role: 'label_printer', op: 'print_label' | 'print_raw', ... })` in `src/services/printing/labelDispatch.ts`.
- Browser mode routes that into `BrowserHardwareAdapter`, then `EscPosPrinterDriver`, then `LocalAgentNetworkTransport`, then `AgentClient.printNetwork(...)`.
- `AgentClient.printNetwork(...)` has a per-endpoint FIFO lock, and the local agent `agent/src/routes/print.ts` also has a per-endpoint FIFO queue.
- There is no preview-dialog fallback in that click path. A rapid click is another hardware job.

**What Sales invoice print uses now**
- `src/pages/Invoices.tsx` calls `generateDocument(...)` from `usePrintOrPreview()`.
- `usePrintOrPreview()` calls `printClient.print(...)`, but if the result is `ask_user`, `none`, or any failed transport, it opens `<PrintPreviewDialog />`.
- So yes: Sales still has a legacy-style preview fallback behavior even after the previous work.
- If the first invoice ESC/POS print succeeds and the next rapid prints hit a transient hardware/agent failure, Sales switches to preview instead of behaving like labels.

**Fix plan — no deferring**
1. **Split “print” from “preview” in Sales**
   - Change the Sales invoice print handler so the Print action does not call `generateDocument(...)` / `usePrintOrPreview()`.
   - Route invoice Print directly through `printClient.print(...)` with a unique per-click idempotency key.
   - Pass the active branch/business scope instead of relying on the preview hook.

2. **Remove automatic preview fallback for Sales print failures**
   - A failed invoice hardware print must show a clear printer error toast and remain a print failure.
   - It must not open `PrintPreviewDialog` unless the user explicitly clicks a Preview / Download action.

3. **Make invoice ESC/POS burst behavior deterministic**
   - Preserve one job per click.
   - Let the existing raw transport FIFO handle ordering: `hardwareClient.printRawBytes` → driver → `AgentClient.printNetwork` endpoint lock → agent FIFO.
   - Do not disable/drop rapid clicks at the Sales UI layer.

4. **Keep preview as an explicit action only**
   - Keep `<PrintPreviewDialog />` available for explicit Preview / Download flows.
   - Do not let the main Sales Print button silently convert into preview.

5. **Add guard tests for this exact regression**
   - Test that the Sales invoice Print handler does not use `generateDocument(...)` / `usePrintOrPreview()` for primary print.
   - Test that invoice print failure does not call `openPreview` / set `printPreviewOpen`.
   - Keep existing Product Labels behavior untouched.

6. **Verify after implementation**
   - Run targeted printing/Sales guard tests.
   - Confirm source path is: Sales Print → `printClient.print` → `generateDocumentEscPosBytes` when policy is ESC/POS → `hardwareClient.printRawBytes` → local agent FIFO.
   - Confirm no automatic preview dialog opens on rapid Sales invoice print failures.