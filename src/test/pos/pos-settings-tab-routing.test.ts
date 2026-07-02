import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("POSSettings tab routing", () => {
  const src = readFileSync(
    resolve(__dirname, "../../pages/pos/POSSettings.tsx"),
    "utf8",
  );

  it("updates tab UI state immediately instead of relying only on URL mutation", () => {
    expect(src).toMatch(/const \[activeTab, setActiveTab\] = useState/);
    expect(src).toMatch(/setActiveTab\(validTab\)/);
    expect(src).toMatch(/<Tabs value=\{activeTab\} onValueChange=\{handleTabChange\}/);
  });

  it("creates fresh URLSearchParams when writing tab changes", () => {
    expect(src).toMatch(/new URLSearchParams\(prev\)/);
    expect(src).not.toMatch(/setSearchParams\(\(p\) => \{\s*p\.set/);
  });

  it("accepts every rendered POS settings tab, including barcodes", () => {
    const triggers = [...src.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1]);
    for (const tab of triggers) {
      expect(src).toContain(`"${tab}"`);
    }
    expect(triggers).toContain("barcodes");
  });
});