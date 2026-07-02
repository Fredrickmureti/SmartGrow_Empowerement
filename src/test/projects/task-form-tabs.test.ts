/**
 * Architecture guard: TaskForm must expose 5 tabs in a fixed order.
 * A pure source-string assertion keeps the test free of React/JSDOM setup
 * while still catching regressions in the tab structure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("TaskForm tab structure", () => {
  const src = readFileSync(
    resolve(__dirname, "../../components/projects/TaskForm.tsx"),
    "utf8",
  );

  it("declares Details, Planning, People, Billing, Advanced in order", () => {
    const expected = ["details", "planning", "people", "billing", "advanced"];
    const triggers = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(triggers).toEqual(expected);
  });

  it("uses a 5-column TabsList grid", () => {
    expect(src).toMatch(/grid-cols-5/);
  });

  it("emits a Next occurrence hint when recurrence is enabled", () => {
    expect(src).toMatch(/Next occurrence:/);
  });
});
