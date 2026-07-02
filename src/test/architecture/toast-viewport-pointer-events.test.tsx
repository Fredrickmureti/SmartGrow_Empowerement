/**
 * Regression test: the toast viewport must not intercept clicks.
 *
 * The empty toast viewport sits at `z-[100]`, fixed, and on mobile spans
 * the full screen width. If it lacks `pointer-events-none`, the entire
 * area becomes a click-eating dead zone — the original "UI becomes
 * unclickable after a few minutes" bug.
 *
 * Toasts themselves re-enable pointer events via `pointer-events-auto`
 * in `toastVariants` (so close/dismiss still works). We only enforce the
 * viewport class here.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Toaster } from "@/components/ui/toaster";

describe("toast viewport pointer-events", () => {
  it("renders the viewport with pointer-events-none", () => {
    const { container } = render(<Toaster />);

    // Radix Toast viewport is a <ol> with role="region" / aria-label "Notifications".
    const viewport = container.querySelector("ol");
    expect(viewport).not.toBeNull();
    expect(viewport!.className).toMatch(/pointer-events-none/);
  });
});
