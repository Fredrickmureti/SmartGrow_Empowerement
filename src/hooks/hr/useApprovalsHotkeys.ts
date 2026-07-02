/**
 * useApprovalsHotkeys — keyboard shortcuts for the Approvals two-pane layout.
 *
 *   J / ↓  → next row
 *   K / ↑  → previous row
 *   A      → approve current row
 *   R      → reject current row
 *   X / Space → toggle pick (bulk select) on current row
 *   Esc    → clear current selection
 *
 * Suspends when:
 *   - the host says `enabled=false` (e.g. a dialog is open)
 *   - focus is inside an input / textarea / contenteditable
 */
import { useEffect } from "react";

interface Options {
  enabled?: boolean;
  ids: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
  onTogglePick?: (id: string) => void;
}

function focusedInTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as any).isContentEditable) return true;
  return false;
}

export function useApprovalsHotkeys({
  enabled = true,
  ids,
  selectedId,
  onSelect,
  onApprove,
  onReject,
  onTogglePick,
}: Options) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (focusedInTextField()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = selectedId ? ids.indexOf(selectedId) : -1;

      const move = (delta: number) => {
        if (ids.length === 0) return;
        const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + delta, 0), ids.length - 1);
        onSelect(ids[nextIdx]);
        e.preventDefault();
      };

      switch (e.key) {
        case "j":
        case "ArrowDown":
          move(1);
          return;
        case "k":
        case "ArrowUp":
          move(-1);
          return;
        case "a":
          if (selectedId && onApprove) {
            onApprove(selectedId);
            e.preventDefault();
          }
          return;
        case "r":
          if (selectedId && onReject) {
            onReject(selectedId);
            e.preventDefault();
          }
          return;
        case "x":
        case " ":
          if (selectedId && onTogglePick) {
            onTogglePick(selectedId);
            e.preventDefault();
          }
          return;
        case "Escape":
          onSelect(null);
          e.preventDefault();
          return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, ids, selectedId, onSelect, onApprove, onReject, onTogglePick]);
}
