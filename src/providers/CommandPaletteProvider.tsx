/**
 * CommandPaletteProvider
 *
 * Mounted once near the top of the React tree (inside the Router so
 * `useNavigate()` works, and inside the auth/session providers so
 * permissions/entitlements are available).
 *
 * Responsibilities:
 *   - Owns the single `useCommandPalette()` instance for the whole app.
 *   - Installs the global keyboard shortcuts:
 *       Cmd/Ctrl+K  → toggle palette anywhere
 *       "/"         → open palette ONLY when focus is not in an editable
 *   - Mounts the `<GlobalCommandPalette />` UI.
 *
 * Components that need to open the palette imperatively (e.g. the
 * navbar Search button) read it via `useCommandPaletteContext()`.
 */

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { GlobalCommandPalette } from "@/components/command/GlobalCommandPalette";

type Ctx = ReturnType<typeof useCommandPalette>;

const CommandPaletteCtx = createContext<Ctx | null>(null);

/** True if the active element should NOT receive a "/" shortcut. */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const ctx = useCommandPalette();
  const { setOpen, open } = ctx;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K — works everywhere, including inside inputs.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!open);
        return;
      }
      // "/" — opens palette only when the user isn't typing somewhere.
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <CommandPaletteCtx.Provider value={ctx}>
      {children}
      <GlobalCommandPalette />
    </CommandPaletteCtx.Provider>
  );
}

export function useCommandPaletteContext(): Ctx {
  const v = useContext(CommandPaletteCtx);
  if (!v) {
    throw new Error(
      "useCommandPaletteContext must be used inside <CommandPaletteProvider>",
    );
  }
  return v;
}
