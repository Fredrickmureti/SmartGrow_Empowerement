/**
 * feedbackTones — operator-grade audio feedback contract.
 *
 * Locks: mute persistence, mute suppresses all tones, vibration fires
 * only on `invalid` + `disconnect`, and `toneForAck` maps the verdict
 * domain correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class FakeOscillator {
  type = "square";
  frequency = {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  state: AudioContextState = "running";
  createdOsc: FakeOscillator[] = [];
  createOscillator() {
    const o = new FakeOscillator();
    this.createdOsc.push(o);
    return o as unknown as OscillatorNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

let ctxInstance: FakeAudioContext | null = null;
let vibrateSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  ctxInstance = null;
  const ACMock = vi.fn().mockImplementation(() => {
    ctxInstance = new FakeAudioContext();
    return ctxInstance;
  });
  (globalThis as any).AudioContext = ACMock;
  (window as any).AudioContext = ACMock;
  vibrateSpy = vi.fn();
  Object.defineProperty(window.navigator, "vibrate", {
    configurable: true,
    value: vibrateSpy,
  });
  window.localStorage.clear();
});

afterEach(() => {
  delete (globalThis as any).AudioContext;
  delete (window as any).AudioContext;
});

async function loadModule() {
  const mod = await import("@/services/scanner/feedbackTones");
  mod.feedbackTones._reset();
  // Force fresh ctx pickup post-reset.
  return mod;
}

describe("feedbackTones", () => {
  it("maps verdict kinds to tones", async () => {
    const { toneForAck } = await loadModule();
    expect(toneForAck("ok")).toBe("ok");
    expect(toneForAck("weighted")).toBe("ok");
    expect(toneForAck("unknown")).toBe("duplicate");
    expect(toneForAck("error")).toBe("invalid");
  });

  it("play() is a no-op-safe call when unmuted", async () => {
    const { feedbackTones } = await loadModule();
    expect(feedbackTones.isMuted()).toBe(false);
    expect(() => feedbackTones.play("ok")).not.toThrow();
  });

  it("mute suppresses all tones", async () => {
    const { feedbackTones } = await loadModule();
    feedbackTones.setMuted(true);
    feedbackTones.play("ok");
    feedbackTones.play("duplicate");
    feedbackTones.play("invalid");
    feedbackTones.play("disconnect");
    expect(ctxInstance).toBeNull();
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it("never vibrates on ok / duplicate tones", async () => {
    const { feedbackTones } = await loadModule();
    feedbackTones.play("ok");
    feedbackTones.play("duplicate");
    expect(vibrateSpy).not.toHaveBeenCalled();
  });

  it("persists mute state across module loads", async () => {
    const a = await loadModule();
    a.feedbackTones.setMuted(true);
    expect(window.localStorage.getItem("scanner.mute")).toBe("1");
    vi.resetModules();
    const b = await import("@/services/scanner/feedbackTones");
    expect(b.feedbackTones.isMuted()).toBe(true);
  });

  it("notifies onMutedChange listeners", async () => {
    const { feedbackTones } = await loadModule();
    const seen: boolean[] = [];
    const off = feedbackTones.onMutedChange((m) => seen.push(m));
    feedbackTones.setMuted(true);
    feedbackTones.setMuted(false);
    off();
    feedbackTones.setMuted(true);
    expect(seen).toEqual([true, false]);
  });
});