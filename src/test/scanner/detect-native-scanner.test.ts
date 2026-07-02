import { describe, it, expect } from "vitest";
import { detectNativeScannerFrom } from "@/services/scanner/native/detectNativeScanner";

describe("detectNativeScanner", () => {
  it("returns null vendor on desktop Chrome", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
    });
    expect(r.vendor).toBeNull();
  });

  it("returns null vendor on iPhone Safari", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
    });
    expect(r.vendor).toBeNull();
  });

  it("returns null on generic Android consumer phone", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36",
    });
    expect(r.vendor).toBeNull();
  });

  it("detects Zebra TC22 via model token", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; TC22) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
    });
    expect(r.vendor).toBe("zebra");
    expect(r.transport).toBe("intent");
    expect(r.label).toBe("Zebra DataWedge");
  });

  it("promotes confidence + transport when DataWedge JS bridge is present", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; TC52ax) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
      hasDWBridge: true,
    });
    expect(r.vendor).toBe("zebra");
    expect(r.transport).toBe("js-bridge");
    expect(r.confidence).toBe(1);
  });

  it("detects Honeywell CT45 via model token", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Linux; Android 12; CT45) AppleWebKit/537.36 Chrome/118.0 Mobile Safari/537.36",
    });
    expect(r.vendor).toBe("honeywell");
    expect(r.label).toBe("Honeywell scan engine");
  });

  it("detects Honeywell via brand token", () => {
    const r = detectNativeScannerFrom({
      userAgent:
        "Mozilla/5.0 (Linux; Android 13; Honeywell EDA52) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36",
    });
    expect(r.vendor).toBe("honeywell");
  });
});
