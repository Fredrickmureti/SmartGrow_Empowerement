/**
 * Wave B3 (Plan P1) — architectural guarantee for the PDF/iframe
 * transport.
 *
 * History and motivation are documented in the printing-pipeline
 * report at .lovable/plan.md. The one-sentence version: prior to this
 * wave, rapid Print-Invoice clicks silently lost jobs 2..N because
 * `PrintPreviewDialog`'s Print button was disabled while
 * `printPdfInPage`'s single-flight iframe/print-dialog promise was
 * pending — React drops onClick on a disabled button, so no job was
 * ever created and no error was raised. The label path was already
 * safe (two independent per-endpoint queues in `AgentClient` +
 * `agent/src/routes/print.ts`). This test locks in the equivalent
 * FIFO guarantee for the PDF branch: N concurrent `printPdfInPage`
 * calls MUST run sequentially and MUST all complete, never coalesced,
 * never dropped, never reordered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  printPdfInPage,
  __printPdfInPageQueueDrained,
} from "@/services/printing/pdfUtils";

class FakeIframe {
  static instances: FakeIframe[] = [];
  style: Record<string, string> = {};
  parentNode: { removeChild: (child: FakeIframe) => void } | null = null;
  isConnected = false;
  contentWindow: {
    focus: () => void;
    print: () => void;
    addEventListener: (evt: string, cb: () => void) => void;
    removeEventListener: (evt: string, cb: () => void) => void;
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = "";
  private _afterPrintHandlers: Array<() => void> = [];
  printCalled = false;

  constructor() {
    FakeIframe.instances.push(this);
    this.contentWindow = {
      focus: () => undefined,
      print: () => {
        this.printCalled = true;
      },
      addEventListener: (evt: string, cb: () => void) => {
        if (evt === "afterprint") this._afterPrintHandlers.push(cb);
      },
      removeEventListener: (evt: string, cb: () => void) => {
        if (evt === "afterprint") {
          this._afterPrintHandlers = this._afterPrintHandlers.filter((h) => h !== cb);
        }
      },
    };
  }

  set src(value: string) {
    this._src = value;
    // Simulate the browser firing `load` on the next microtask so the
    // queue actually has a chance to see overlapping calls.
    queueMicrotask(() => this.onload?.());
  }
  get src(): string {
    return this._src;
  }

  /** Simulate the user dismissing the browser's print dialog. */
  finishPrintDialog() {
    for (const cb of [...this._afterPrintHandlers]) cb();
  }
}

describe("printPdfInPage global FIFO queue (Plan P1)", () => {
  const originalCreateElement = document.createElement.bind(document);
  const originalAppendChild = document.body.appendChild.bind(document.body);

  beforeEach(() => {
    FakeIframe.instances = [];
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "iframe") {
        return new FakeIframe() as unknown as HTMLElement;
      }
      return originalCreateElement(tag);
    });
    vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
      if (node instanceof FakeIframe) {
        (node as FakeIframe).isConnected = true;
        (node as FakeIframe).parentNode = {
          removeChild: (child) => {
            child.isConnected = false;
          },
        };
        return node as unknown as Node;
      }
      return originalAppendChild(node);
    });
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => undefined,
    });
    // Silence the 60s safety timeout — tests drive completion via
    // finishPrintDialog(). Use real timers for microtask/promise flush.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("serializes N concurrent calls: only one iframe/print dialog is live at a time", async () => {
    // Fire 5 rapid prints. Prior to Plan P1, either they'd all spawn
    // iframes simultaneously (stacking modal dialogs) or the caller's
    // `disabled` guard would drop 4 of them entirely.
    const blob = new Blob(["%PDF-1.4 fake"], { type: "application/pdf" });
    const promises = [
      printPdfInPage(blob),
      printPdfInPage(blob),
      printPdfInPage(blob),
      printPdfInPage(blob),
      printPdfInPage(blob),
    ];

    // Allow the queue to start the first job.
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one iframe exists — the queue is holding calls 2..5.
    expect(FakeIframe.instances.length).toBe(1);
    expect(FakeIframe.instances[0].printCalled).toBe(true);

    // Complete jobs one by one. Each completion MUST advance the queue
    // to the next iframe/dialog — never skip, never coalesce.
    for (let i = 0; i < 5; i++) {
      FakeIframe.instances[i].finishPrintDialog();
      // Await the settled job so the next one starts.
      await promises[i];
      // Give the queue chain a microtask to spawn the next iframe.
      await Promise.resolve();
      await Promise.resolve();
    }

    // All 5 jobs ran to completion in order.
    expect(FakeIframe.instances.length).toBe(5);
    for (const frame of FakeIframe.instances) {
      expect(frame.printCalled).toBe(true);
    }

    await __printPdfInPageQueueDrained();
  });

  it("a failing job does not poison the queue for subsequent jobs", async () => {
    // First job errors; second job MUST still run. This protects
    // against the "one bad PDF cancels every future invoice print"
    // regression that a naive `queue = queue.then(fn)` would create.
    const blob = new Blob(["%PDF-1.4 fake"], { type: "application/pdf" });
    const p1 = printPdfInPage(blob);
    const p2 = printPdfInPage(blob);

    await Promise.resolve();
    await Promise.resolve();

    expect(FakeIframe.instances.length).toBe(1);
    // Simulate the browser's iframe raising an error (blocked, CSP,
    // renderer destroyed). The current implementation resolves rather
    // than rejects on this path, but the invariant is: p2 runs.
    FakeIframe.instances[0].onerror?.();
    await p1;

    await Promise.resolve();
    await Promise.resolve();
    expect(FakeIframe.instances.length).toBe(2);
    FakeIframe.instances[1].finishPrintDialog();
    await p2;
    expect(FakeIframe.instances[1].printCalled).toBe(true);
  });
});
