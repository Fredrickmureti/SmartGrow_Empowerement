/**
 * Architecture guard — the AI assistant boundary.
 *
 * 1. No browser-side module may talk to an AI provider directly or read an
 *    AI provider key. Provider credentials live server-side (env + Vault) and
 *    are only ever resolved inside edge functions.
 * 2. `ai-assistant` stays the single client entry point for assistant chat —
 *    no parallel chat endpoint may appear in `src/`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

const SRC_FILES = globSync("src/**/*.{ts,tsx}", { nodir: true }).filter(
  (f) => !f.includes("__tests__") && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
);

const PROVIDER_ENDPOINTS = [
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "openrouter.ai/api",
  "ai.gateway.lovable.dev",
];

const PROVIDER_KEY_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "LOVABLE_API_KEY",
];

describe("AI assistant boundary", () => {
  it("no browser module calls an AI provider endpoint directly", () => {
    const offenders = SRC_FILES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return PROVIDER_ENDPOINTS.some((host) => src.includes(host));
    });
    expect(offenders).toEqual([]);
  });

  it("no browser module reads an AI provider API key", () => {
    const offenders = SRC_FILES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return PROVIDER_KEY_NAMES.some((key) => src.includes(key));
    });
    expect(offenders).toEqual([]);
  });

  it("assistant chat goes through the ai-assistant edge function only", () => {
    const offenders = SRC_FILES.filter((file) => {
      const src = readFileSync(file, "utf8");
      return /functions\/v1\/(ai-chat|assistant-chat|chat)\b/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
