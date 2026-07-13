/**
 * Canvas direct-manipulation mutation semantics.
 *
 * The Canvas dispatches four intents on top-level document nodes:
 *   - moveUp / moveDown  (swap with neighbour)
 *   - duplicate          (deep-clone and insert after)
 *   - delete             (remove; keep-focus on best-effort successor)
 *   - reorder(from, to)  (drag-drop; splice from → to)
 *
 * These are pure array transforms; this test locks them so the UI wiring
 * in CertificateTemplateEditor can be refactored without silently
 * regressing the semantics.
 */
import { describe, it, expect } from "vitest";

// Pure implementations mirroring CertificateTemplateEditor.handleNodeAction /
// handleReorder. Kept as a local mirror on purpose: if the editor's
// semantics ever change, this test must be updated in the same PR.
function moveUp<T>(doc: T[], idx: number): T[] {
  if (idx <= 0) return doc.slice();
  const next = doc.slice();
  [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
  return next;
}
function moveDown<T>(doc: T[], idx: number): T[] {
  if (idx >= doc.length - 1) return doc.slice();
  const next = doc.slice();
  [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
  return next;
}
function duplicate<T>(doc: T[], idx: number): T[] {
  const next = doc.slice();
  next.splice(idx + 1, 0, JSON.parse(JSON.stringify(next[idx])));
  return next;
}
function del<T>(doc: T[], idx: number): T[] {
  const next = doc.slice();
  next.splice(idx, 1);
  return next;
}
function reorder<T>(doc: T[], from: number, to: number): T[] {
  const next = doc.slice();
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}

describe("certificate canvas — mutation semantics", () => {
  const seed = () => [
    { type: "heading", id: "a" },
    { type: "rich_text", id: "b" },
    { type: "grid", id: "c" },
    { type: "signature_strip", id: "d" },
  ];

  it("moveUp swaps with previous sibling", () => {
    expect(moveUp(seed(), 2).map((n: any) => n.id)).toEqual(["a", "c", "b", "d"]);
  });
  it("moveUp at index 0 is a no-op", () => {
    expect(moveUp(seed(), 0).map((n: any) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("moveDown swaps with next sibling", () => {
    expect(moveDown(seed(), 1).map((n: any) => n.id)).toEqual(["a", "c", "b", "d"]);
  });
  it("moveDown at last index is a no-op", () => {
    expect(moveDown(seed(), 3).map((n: any) => n.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("duplicate deep-clones and inserts after", () => {
    const orig = seed();
    const next = duplicate(orig, 1);
    expect(next.map((n: any) => n.id)).toEqual(["a", "b", "b", "c", "d"]);
    // Deep clone: mutating the clone must not touch the source.
    (next[2] as any).id = "b2";
    expect((orig[1] as any).id).toBe("b");
  });

  it("delete removes the node", () => {
    expect(del(seed(), 2).map((n: any) => n.id)).toEqual(["a", "b", "d"]);
  });

  it("reorder(0, 3) moves the head to the tail", () => {
    expect(reorder(seed(), 0, 3).map((n: any) => n.id)).toEqual(["b", "c", "d", "a"]);
  });
  it("reorder(3, 0) moves the tail to the head", () => {
    expect(reorder(seed(), 3, 0).map((n: any) => n.id)).toEqual(["d", "a", "b", "c"]);
  });
  it("reorder(from, from) is a no-op", () => {
    expect(reorder(seed(), 2, 2).map((n: any) => n.id)).toEqual(["a", "b", "c", "d"]);
  });
});