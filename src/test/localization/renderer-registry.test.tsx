/**
 * rendererRegistry unit tests — pins the (artefact × formatKind) →
 * renderer descriptor contract that BOTH the split-pane preview and
 * the detached pop-out window rely on. Any new artefact type MUST add
 * a case here so the dispatcher never silently falls through.
 */
import { describe, it, expect } from "vitest";
import {
  resolveReturnRenderer,
  resolvePopOutRenderer,
  describeReturnFormat,
  type ReturnFormatKind,
} from "../../features/localization/lib/preview/rendererRegistry";
import type {
  PreviewKind,
  PreviewPayload,
} from "../../features/localization/lib/previewBroadcast";

describe("resolveReturnRenderer", () => {
  const formats: ReturnFormatKind[] = ["csv", "xlsx", "xml", "json", "pdf"];
  it.each(formats)("returns a descriptor for %s", (f) => {
    const d = resolveReturnRenderer(f);
    expect(d.formatKind).toBe(f);
    expect(d.id).toMatch(new RegExp(`^return/${f === "pdf" ? "pdf" : f}`));
    expect(typeof d.render).toBe("function");
  });

  it("returns the shared HTML/paged.js descriptor for pdf returns", () => {
    // The legacy v2-returns section renderer was retired in ADR 0063,
    // so pdf returns always resolve through the single `return/pdf`
    // descriptor (returnToAst → CertificateHtmlSurface).
    expect(resolveReturnRenderer("pdf").id).toBe("return/pdf");
  });
});

describe("describeReturnFormat", () => {
  it("produces a human label for each supported format", () => {
    expect(describeReturnFormat("csv")).toMatch(/CSV/);
    expect(describeReturnFormat("xlsx")).toMatch(/Excel/);
    expect(describeReturnFormat("xml")).toMatch(/XML/);
    expect(describeReturnFormat("json")).toMatch(/JSON/);
    expect(describeReturnFormat("pdf")).toMatch(/PDF/);
  });
});

describe("resolvePopOutRenderer", () => {
  const kinds: PreviewKind[] = [
    "certificate",
    "return",
    "bank-export",
    "garnishment",
    "token-registry",
    "statutory-authority",
    "pack-requirements",
    "publisher-governance",
  ];
  const stubPayload = (kind: PreviewKind): PreviewPayload => ({
    kind,
    templateCode: "TEST",
    body: kind === "return"
      ? { columns: [] }
      : kind === "bank-export" || kind === "garnishment" || kind === "token-registry"
        ? { columns: [], rows: [] }
        : kind === "statutory-authority" || kind === "pack-requirements" || kind === "publisher-governance"
          ? { items: [] }
          : { document: [], schema_version: 4 },
    meta: kind === "return" ? { submission_format: { kind: "csv" } } : null,
    displayName: null,
    updatedAt: 0,
  });

  it.each(kinds)("returns a React element for kind %s", (k) => {
    const el = resolvePopOutRenderer(k, stubPayload(k));
    expect(el).toBeDefined();
    // Every path must produce a JSX element, never null/undefined.
    expect((el as any).type).toBeDefined();
  });

  it("returns the empty-state element for an unknown kind", () => {
    const el = resolvePopOutRenderer("nonsense" as PreviewKind, stubPayload("certificate"));
    expect(el).toBeDefined();
    expect((el as any).type).toBeDefined();
  });
});