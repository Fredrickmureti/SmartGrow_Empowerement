/**
 * H8 — Single canonical shortcut help overlay.
 * Press `?` anywhere in the POS terminal to show all bindings. Source of
 * truth is `POS_SHORTCUTS_HELP` exported by `usePOSKeyboardShortcuts`, so
 * documented = wired by construction.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { POS_SHORTCUTS_HELP } from "@/hooks/pos/usePOSKeyboardShortcuts";

export function KeyboardShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">?</kbd> anytime to toggle this list.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y">
          {POS_SHORTCUTS_HELP.map((s) => (
            <li key={s.key} className="flex items-center justify-between py-2">
              <span className="text-sm">{s.label}</span>
              <Badge variant="outline" className="font-mono text-xs">{s.key}</Badge>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}