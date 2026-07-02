/**
 * PhoneShortcutsOverlay — phone-side `?` overlay (wave 5 Track D).
 *
 * Mirrors `KeyboardShortcutsOverlay` on the desk, exposing the few
 * shortcuts a paired iPad/Bluetooth-keyboard operator actually uses:
 *   ?  toggle this overlay
 *   R  manual reconnect
 *   M  mute / unmute audio feedback
 *   K  open / close manual entry
 *   Esc close overlay (and manual entry, handled at the page level)
 *
 * Handlers are passed in so the page owns the side effects.
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

interface Props {
  onReconnect: () => void;
  onToggleMute: () => void;
  onToggleManual: () => void;
}

const SHORTCUTS: Array<{ key: string; label: string }> = [
  { key: "?",   label: "Toggle this overlay" },
  { key: "R",   label: "Reconnect now" },
  { key: "M",   label: "Mute / unmute scanner sounds" },
  { key: "K",   label: "Open / close manual entry" },
  { key: "Esc", label: "Close overlay" },
];

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function PhoneShortcutsOverlay({ onReconnect, onToggleMute, onToggleManual }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "?") { e.preventDefault(); setOpen((p) => !p); return; }
      if (e.key === "Escape") { setOpen(false); return; }
      const k = e.key.toLowerCase();
      if (k === "r") { e.preventDefault(); onReconnect(); }
      else if (k === "m") { e.preventDefault(); onToggleMute(); }
      else if (k === "k") { e.preventDefault(); onToggleManual(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReconnect, onToggleMute, onToggleManual]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Scanner shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">?</kbd> to toggle this list.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y">
          {SHORTCUTS.map((s) => (
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
