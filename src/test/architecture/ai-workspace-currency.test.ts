import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

/**
 * The AI assistant must never speak a currency it did not read from the
 * tenant. It used to select `organizations.base_currency` — a column that
 * does not exist — and fall back to `'USD'`, so every workspace was told it
 * was a dollar workspace. These ratchets keep that from coming back.
 */

const ASSISTANT = "supabase/functions/ai-assistant/index.ts";
const RESOLVER = "supabase/functions/_shared/workspaceCurrency.ts";

const read = (p: string) => readFileSync(p, "utf8");

/** Strip comments and template literals so prose about USD isn't a match. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/`[\s\S]*?`/g, "``");

describe("AI assistant workspace currency", () => {
  it("has the shared server-side currency resolver", () => {
    expect(existsSync(RESOLVER)).toBe(true);
    const src = read(RESOLVER);
    expect(src).toContain("businesses");
    expect(src).toContain("base_currency");
    // The resolver itself must not invent a currency.
    expect(code(RESOLVER)).not.toMatch(/['"]USD['"]/);
  });

  it("never reads base_currency off organizations", () => {
    const src = read(ASSISTANT);
    expect(src).not.toMatch(/from\(["']organizations["']\)[\s\S]{0,200}base_currency/);
  });

  it("has no literal currency fallback", () => {
    for (const f of [ASSISTANT, RESOLVER]) {
      expect(code(f), `${f} must not fall back to a currency literal`).not.toMatch(
        /['"](USD|EUR|GBP|KES)['"]/,
      );
    }
  });

  it("resolves the currency for every request type, not just chat", () => {
    const src = read(ASSISTANT);
    expect(src).toContain("resolveWorkspaceCurrency");
    expect(src).toContain("buildCurrencyRulePrompt");
    // The universal injection happens outside the chat-only branch.
    const universal = src.indexOf('systemPrompt += "\\n\\n" + buildCurrencyRulePrompt(currencyCtx);');
    expect(universal).toBeGreaterThan(-1);
  });

  it("formats money with an explicit ISO code", () => {
    const src = read(RESOLVER);
    expect(src).toContain("export function formatMoney");
    expect(src).toContain("currency not configured");
  });
});
