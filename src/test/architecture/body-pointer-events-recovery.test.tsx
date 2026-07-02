/**
 * Regression test: BodyPointerEventsGuard clears stuck `pointer-events: none`
 * on <body> when there is no actually-open Radix overlay in the DOM.
 *
 * Reproduces the "Radix unmounted while open" leak that freezes the entire
 * UI (page scrolls but nothing is clickable).
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BodyPointerEventsGuard } from "@/components/common/BodyPointerEventsGuard";

// Guard now uses useLocation() for per-route sweeps; tests must wrap it.
const renderGuard = () =>
  render(
    <MemoryRouter>
      <BodyPointerEventsGuard />
    </MemoryRouter>,
  );

afterEach(() => {
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("aria-hidden");
  document.body.removeAttribute("inert");
  document.body.removeAttribute("data-scroll-locked");
  cleanup();
});

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BodyPointerEventsGuard", () => {
  it("clears stuck pointer-events:none on <body> when no overlay is open", async () => {
    renderGuard();

    document.body.style.pointerEvents = "none";
    expect(document.body.style.pointerEvents).toBe("none");

    await wait(250);

    expect(document.body.style.pointerEvents).toBe("");
  });

  it("does NOT clear pointer-events:none when an overlay is actually open", async () => {
    renderGuard();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);

    document.body.style.pointerEvents = "none";
    await wait(250);

    expect(document.body.style.pointerEvents).toBe("none");

    document.body.removeChild(dialog);
  });

  it("clears aria-hidden, inert, and data-scroll-locked residue on body", async () => {
    renderGuard();

    document.body.setAttribute("aria-hidden", "true");
    document.body.setAttribute("inert", "");
    document.body.setAttribute("data-scroll-locked", "1");

    await wait(250);

    expect(document.body.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.hasAttribute("inert")).toBe(false);
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  });
});
