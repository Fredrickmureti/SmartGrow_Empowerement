/**
 * buildIndex tests
 *
 * Smoke-tests that every app and module from APP_REGISTRY produces a
 * matching CommandEntry, and that legacy URL aliases are folded into
 * keywords so old paths remain searchable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { APP_REGISTRY, LEGACY_ROUTE_MAPPINGS } from "@/lib/apps/registry";
import { getStaticCommandIndex, __resetStaticIndexForTests } from "../buildIndex";

describe("getStaticCommandIndex", () => {
  beforeEach(() => __resetStaticIndexForTests());

  it("emits one module entry per app", () => {
    const idx = getStaticCommandIndex();
    for (const app of APP_REGISTRY) {
      const e = idx.find((x) => x.id === `module:${app.id}`);
      expect(e, `missing module entry for ${app.id}`).toBeTruthy();
      expect(e!.kind).toBe("module");
      expect(e!.title).toBe(app.name);
    }
  });

  it("emits a page entry for every visible module", () => {
    const idx = getStaticCommandIndex();
    for (const app of APP_REGISTRY) {
      for (const mod of app.modules) {
        if (mod.hidden) continue;
        const e = idx.find((x) => x.id === `page:${app.id}/${mod.id}`);
        expect(e, `missing page for ${app.id}/${mod.id}`).toBeTruthy();
        expect(e!.to).toBe(`${app.basePath}${mod.path}`);
      }
    }
  });

  it("folds legacy paths into keywords for matching pages", () => {
    const idx = getStaticCommandIndex();
    for (const [legacy, full] of Object.entries(LEGACY_ROUTE_MAPPINGS)) {
      const target = idx.find((e) => e.to === full);
      if (!target) continue; // some legacy paths point at non-module routes
      const alias = legacy.replace(/^\//, "").toLowerCase();
      expect(
        target.keywords.includes(alias),
        `expected keyword "${alias}" on entry ${target.id}`,
      ).toBe(true);
    }
  });

  it("is frozen and stable across calls", () => {
    const a = getStaticCommandIndex();
    const b = getStaticCommandIndex();
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
