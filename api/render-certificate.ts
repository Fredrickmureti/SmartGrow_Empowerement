/**
 * Certificate Renderer — Vercel Serverless Function.
 *
 * Owned infrastructure for Certificate Engine v3. Lives in this repo,
 * deploys with the app to Vercel (no Docker, no K8s, no third-party
 * API). Same architectural pattern as Odoo's in-tree wkhtmltopdf: the
 * platform owns its rendering runtime.
 *
 * Contract:
 *   POST /api/render-certificate
 *   Headers:
 *     X-Signature: hex(HMAC-SHA256(body, CERT_RENDERER_SIGNING_SECRET))
 *     Content-Type: application/json
 *   Body:  { "html": "<full self-contained HTML document>" }
 *   200:   application/pdf bytes
 *   401:   bad/missing signature
 *   400:   malformed body
 *   500:   render failed
 *
 * Called by `generate-tax-certificate` (Supabase edge) via
 * `vercelChromiumProducer.ts`. This file is country-agnostic — it
 * rasterises HTML, nothing more.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = {
  // Chromium binary + PDF generation needs headroom.
  maxDuration: 60,
  memory: 1024,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const secret = process.env.CERT_RENDERER_SIGNING_SECRET;
  if (!secret) {
    res.status(503).json({ error: "renderer_not_configured",
      detail: "CERT_RENDERER_SIGNING_SECRET is not set on Vercel." });
    return;
  }

  // Vercel gives us the parsed body for JSON. We need the raw bytes to
  // verify the HMAC produced by the edge function, so re-serialise using
  // the identical JSON.stringify shape the producer uses.
  const parsed = req.body && typeof req.body === "object"
    ? req.body
    : safeParse(req.body);
  if (!parsed || typeof parsed.html !== "string" || !parsed.html) {
    res.status(400).json({ error: "invalid_body", detail: "missing 'html'" });
    return;
  }
  const canonical = JSON.stringify({ html: parsed.html });

  const provided = String(req.headers["x-signature"] ?? "");
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))
  ) {
    res.status(401).json({ error: "bad_signature" });
    return;
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    // waitUntil networkidle0 = wait for all resources; our HTML is
    // self-contained so this returns immediately.
    await page.setContent(parsed.html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      preferCSSPageSize: true,        // honour @page from the compiler
      printBackground: true,
      displayHeaderFooter: false,     // page master is inline in the HTML
    });
    res.setHeader("Content-Type", "application/pdf");
    res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "render_failed", detail: msg.slice(0, 400) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function safeParse(raw: unknown): { html?: string } | null {
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch { return null; }
}
