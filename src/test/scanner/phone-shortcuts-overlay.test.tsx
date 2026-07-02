/**
 * PhoneShortcutsOverlay — wave-6 close-out.
 *
 * Locks: `?` toggles the overlay, R/M/K fire handlers, all keys are
 * ignored while typing into an <input>, <textarea>, or contentEditable.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PhoneShortcutsOverlay } from "@/components/scanner/PhoneShortcutsOverlay";

function setup() {
  const onReconnect = vi.fn();
  const onToggleMute = vi.fn();
  const onToggleManual = vi.fn();
  render(
    <PhoneShortcutsOverlay
      onReconnect={onReconnect}
      onToggleMute={onToggleMute}
      onToggleManual={onToggleManual}
    />,
  );
  return { onReconnect, onToggleMute, onToggleManual };
}

describe("PhoneShortcutsOverlay", () => {
  it("toggles open/closed with ?", () => {
    setup();
    expect(screen.queryByText("Scanner shortcuts")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByText("Scanner shortcuts")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByText("Scanner shortcuts")).not.toBeInTheDocument();
  });

  it("fires R / M / K handlers", () => {
    const { onReconnect, onToggleMute, onToggleManual } = setup();
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "M" });
    fireEvent.keyDown(window, { key: "k" });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(onToggleManual).toHaveBeenCalledTimes(1);
  });

  it("ignores keys while typing into an input", () => {
    const { onReconnect } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "r" });
    fireEvent.keyDown(input, { key: "?" });
    expect(onReconnect).not.toHaveBeenCalled();
    expect(screen.queryByText("Scanner shortcuts")).not.toBeInTheDocument();
    input.remove();
  });

  it("Escape closes the overlay", () => {
    setup();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByText("Scanner shortcuts")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Scanner shortcuts")).not.toBeInTheDocument();
  });
});
