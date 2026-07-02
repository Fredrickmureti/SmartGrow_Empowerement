/**
 * DetailSheet — the single approved right-side drawer for peeking or
 * quick-editing a business record from a list. Same header/footer
 * contract as RecordShell so users see the same layout language whether
 * a record opens in a sheet or on its own page.
 *
 * Sizes: "sm" 480px · "md" 600px · "lg" 720px · "xl" 880px.
 * Anything wider is not a sheet — promote to an object page.
 */
import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg" | "xl";
const sizeClass: Record<Size, string> = {
  sm: "sm:max-w-[480px]",
  md: "sm:max-w-[600px]",
  lg: "sm:max-w-[720px]",
  xl: "sm:max-w-[880px]",
};

interface DetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Record title. */
  title: ReactNode;
  /** Optional description below the title. */
  description?: ReactNode;
  /** Optional right-aligned header actions (compact). */
  headerActions?: ReactNode;
  /** Optional sticky footer (FooterActionBar with anchor="sheet"). */
  footer?: ReactNode;
  size?: Size;
  children: ReactNode;
  className?: string;
}

export function DetailSheet({
  open,
  onOpenChange,
  title,
  description,
  headerActions,
  footer,
  size = "md",
  children,
  className,
}: DetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full flex-col gap-0 p-0",
          sizeClass[size],
          className,
        )}
      >
        <SheetHeader className="flex flex-row items-start justify-between gap-3 space-y-0 border-b px-6 py-4">
          <div className="min-w-0">
            <SheetTitle className="text-lg font-semibold leading-tight">
              {title}
            </SheetTitle>
            {description && (
              <SheetDescription className="mt-0.5 text-sm">
                {description}
              </SheetDescription>
            )}
          </div>
          {headerActions && (
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
            </div>
          )}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer}
      </SheetContent>
    </Sheet>
  );
}