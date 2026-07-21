/**
 * SheetShell — canonical container for every POS sheet.
 *
 * The workstation-states doc requires sheets to auto-dismiss when the
 * phase changes. This component enforces that by refusing to render if
 * the caller's declared `sheet` is not in the current phase's allow-list.
 *
 * Consumers pass:
 *   - `sheet`   — the SheetId this component represents
 *   - `title`   — accessible label for the slide-in
 *   - `side`    — 'right' (default) for line/sale sheets, 'bottom' on
 *                 mobile-narrow terminals for keypad-adjacent sheets
 *   - `children`
 *
 * Sheets never own transactional state — they read from
 * `useTerminalContext()` and existing cart/shift hooks, and dispatch
 * intents back into the reducer. Anything that transitions the phase
 * (payment, receipt) is a workspace, not a sheet.
 */

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTerminalContext } from "./TerminalStateContext";
import type { SheetId } from "./useTerminalState";
import { cn } from "@/lib/utils";

interface SheetShellProps {
  sheet: SheetId;
  title: string;
  side?: "right" | "bottom";
  className?: string;
  children: ReactNode;
}

export function SheetShell({ sheet, title, side = "right", className, children }: SheetShellProps) {
  const { state, isSheetOpen, closeSheet, canOpenSheet } = useTerminalContext();

  // Enforce the sheets-vs-workspaces rule. A sheet that isn't legal in
  // the current phase never mounts — that's the auto-dismiss behaviour
  // the state chart requires.
  const legal = canOpenSheet(sheet);
  const open = legal && isSheetOpen(sheet);

  // Sheets whose phase changed while open silently close; the reducer
  // will have already cleared `activeSheet` on phase change, so this
  // branch mainly guards against illegal caller `openSheet` attempts.
  if (!legal && state.activeSheet === sheet) {
    // Fire-and-forget cleanup; safe because closeSheet is stable.
    queueMicrotask(closeSheet);
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : closeSheet())}>
      <SheetContent
        side={side}
        className={cn(
          side === "right" ? "w-full sm:max-w-lg" : "h-[85vh]",
          "flex flex-col gap-0 p-0",
          className,
        )}
      >
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
