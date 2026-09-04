/**
 * Tests for parseQuery — smart input parsing for the command palette.
 */

import { describe, it, expect } from "vitest";
import { parseQuery } from "../parseQuery";

describe("parseQuery", () => {
  it("returns empty for whitespace input", () => {
    const p = parseQuery("   ");
    expect(p.text).toBe("");
    expect(p.kindScope).toBeNull();
    expect(p.providerScope).toBeNull();
  });

  it("recognises the help prefix", () => {
    const p = parseQuery("?");
    expect(p.help).toBe(true);
    expect(p.text).toBe("");
  });

  it("scopes to actions on `>` prefix", () => {
    const p = parseQuery("> create invoice");
    expect(p.kindScope).toBe("action");
    expect(p.text).toBe("create invoice");
  });

  it("scopes to records on `#` prefix", () => {
    const p = parseQuery("#1042");
    expect(p.kindScope).toBe("record");
    expect(p.text).toBe("1042");
  });

  it("hints clients for `client acme`", () => {
    const p = parseQuery("client acme");
    expect(p.kindScope).toBe("record");
    expect(p.providerScope).toBe("records:customers");
    expect(p.text).toBe("acme");
  });

  it("hints clients for `borrower jane`", () => {
    const p = parseQuery("borrower jane");
    expect(p.providerScope).toBe("records:customers");
    expect(p.text).toBe("jane");
  });

  it("hints journal entries for `je 2025-001`", () => {
    const p = parseQuery("je 2025-001");
    expect(p.providerScope).toBe("records:journal-entries");
    expect(p.text).toBe("2025-001");
  });

  it("does not hint when the alias has no tail", () => {
    const p = parseQuery("invoice");
    expect(p.kindScope).toBeNull();
    expect(p.providerScope).toBeNull();
    expect(p.text).toBe("invoice");
  });

  it("ignores unknown leading words", () => {
    const p = parseQuery("foo bar");
    expect(p.kindScope).toBeNull();
    expect(p.providerScope).toBeNull();
    expect(p.text).toBe("foo bar");
  });

  it("preserves the raw input on every parse", () => {
    const p = parseQuery("  > Create Invoice  ");
    expect(p.raw).toBe("  > Create Invoice  ");
  });
});
