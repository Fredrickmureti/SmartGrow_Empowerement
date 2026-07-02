/**
 * useListHotkeys — generalized J/K/A/R/X/Esc keyboard navigation for any
 * list+detail or approvals surface across the HR modules.
 *
 * Factored from useApprovalsHotkeys so Timesheets and Time-off approvals
 * surfaces share the same shortcuts as Attendance Approvals without
 * copy-pasting the behavior.
 *
 *   J / ArrowDown  → next row
 *   K / ArrowUp    → previous row
 *   A              → invoke onApprove(currentId)
 *   R              → invoke onReject(currentId)
 *   X / Space      → invoke onTogglePick(currentId)
 *   Escape         → clear selection
 *
 * Suspends while focus is inside an input / textarea / contenteditable, or
 * when `enabled` is false (e.g. a modal is open).
 */
import { useEffect } from "react";

export interface UseListHotkeysOptions {
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
  if ((el as { isContentEditable?: boolean }).isContentEditable) return true;
  return false;
}

export function useListHotkeys({
  enabled = true,
  ids,
  selectedId,
  onSelect,
  onApprove,
  onReject,
  onTogglePick,
}: UseListHotkeysOptions) {
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
          if (selectedId && onApprove) { onApprove(selectedId); e.preventDefault(); }
          return;
        case "r":
          if (selectedId && onReject) { onReject(selectedId); e.preventDefault(); }
          return;
        case "x":
        case " ":
          if (selectedId && onTogglePick) { onTogglePick(selectedId); e.preventDefault(); }
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
