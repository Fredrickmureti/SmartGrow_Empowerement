/**
 * Masthead identity guard.
 *
 * A statement must be self-identifying (IAS 1): period covered, basis of
 * preparation and reporting scope. `renderReport` resolves all three and
 * hands them to `drawBrandedHeader`; a previous version of the operational
 * masthead destructured only `title`/`dateRange` and silently dropped the
 * rest, so the downloaded PDF said less than the screen. These tests fail
 * if that regression returns.
 */
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { drawBrandedHeader } from "../components/BrandedHeader.ts";

function captureHeader(config: Parameters<typeof drawBrandedHeader>[2], builder: PdfBuilder) {
  const texts: string[] = [];
  const stub = {
    drawText: (t: string) => texts.push(t),
    drawLine: () => {},
    drawImage: () => {},
  } as unknown as PDFPage;
  const drawn = drawBrandedHeader(builder, stub, config);
  return { texts, drawn };
}

Deno.test("masthead prints period, basis and scope", async () => {
  const builder = await PdfBuilder.create({ paperFormat: "a4" });
  const { texts, drawn } = captureHeader(
    {
      title: "Profit & Loss Statement",
      dateRange: "Jan 1, 2026 - Aug 31, 2026",
      subtitle: "Accrual Basis",
      scope: "Headquarters (HQ)",
      companyName: "Joshua Holdings",
    },
    builder,
  );
  assert(texts.some((t) => t === "For the period Jan 1, 2026 - Aug 31, 2026"), texts.join(" | "));
  assert(texts.includes("Accrual Basis"), texts.join(" | "));
  assert(texts.includes("Headquarters (HQ)"), texts.join(" | "));
  assert(drawn.bodyY < drawn.separatorY);
});

Deno.test("point-in-time reports print 'As of', never a period", async () => {
  const builder = await PdfBuilder.create({ paperFormat: "a4" });
  const { texts } = captureHeader(
    {
      title: "Balance Sheet",
      asOf: "August 31, 2026",
      subtitle: "Accrual Basis",
      scope: "All branches",
      companyName: "Joshua Holdings",
    },
    builder,
  );
  assert(texts.includes("As of August 31, 2026"), texts.join(" | "));
  assert(!texts.some((t) => t.startsWith("For the period")), texts.join(" | "));
});

Deno.test("no double prefixing when the caller already wrote one", async () => {
  const builder = await PdfBuilder.create({ paperFormat: "a4" });
  const { texts } = captureHeader(
    { title: "Trial Balance", dateRange: "As of August 31, 2026", companyName: "X" },
    builder,
  );
  assert(texts.includes("As of August 31, 2026"), texts.join(" | "));
});
