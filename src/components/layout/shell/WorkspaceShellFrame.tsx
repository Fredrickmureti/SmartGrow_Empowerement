/**
 * WorkspaceShellFrame — pure presentational chrome shared by both the
 * tenant `PlatformShell` and the persona-level
 * `PlatformAdminAppLayout`. Owns the outer flex container, sidebar
 * slot, mobile Sheet, topbar slot, optional banner slot, and the main
 * content area with its `max-w-6xl` cap + padding tokens (with page-
 * level `useFullWidthRequested()` opt-in).
 *
 * The frame is intentionally data-free: no session/access/install
 * gates, no data hooks. Each caller keeps its own gating in its
 * wrapper. This is the seam that lets tenant and admin share
 * identical chrome (Phase 7.2 of `docs/design-system/audit/platform-admin.md`).
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useFullWidthRequested } from "@/contexts/AppLayoutContext";

interface WorkspaceShellFrameProps {
  /** Desktop sidebar. Rendered as the first flex child. */
  sidebar: ReactNode;
  /** Rendered inside the mobile `Sheet` (drawer). */
  mobileSidebar: ReactNode;
  /** Sticky topbar rendered above `<main>`. */
  topBar: ReactNode;
  /** Optional slot rendered between the topbar and the content wrapper (subscription banners etc.). */
  aboveContent?: ReactNode;
  /** Optional slot rendered inside the content wrapper, before children (in-app banners). */
  insideContent?: ReactNode;
  children?: ReactNode;
  /** Drop the max-w-6xl page-content cap. */
  fullWidth?: boolean;
  /** Drop the default content padding. */
  noPadding?: boolean;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (v: boolean) => void;
  /** Mobile Sheet width class. Defaults to `w-80`. */
  mobileSheetWidthClass?: string;
}

export function WorkspaceShellFrame({
  sidebar,
  mobileSidebar,
  topBar,
  aboveContent,
  insideContent,
  children,
  fullWidth = false,
  noPadding = false,
  mobileNavOpen,
  onMobileNavOpenChange,
  mobileSheetWidthClass = "w-80",
}: WorkspaceShellFrameProps) {
  const pageFullWidth = useFullWidthRequested();
  const effectiveFullWidth = fullWidth || pageFullWidth;

  return (
    <div className="flex min-h-screen w-full bg-background">
      {sidebar}

      <Sheet open={mobileNavOpen} onOpenChange={onMobileNavOpenChange}>
        <SheetContent side="left" className={cn(mobileSheetWidthClass, "p-0 flex flex-col")}>
          {mobileSidebar}
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col min-w-0">
        {topBar}
        {aboveContent}

        <main className="flex-1 overflow-auto">
          <div
            className={cn(
              "@container/page mx-auto w-full",
              !effectiveFullWidth && "max-w-6xl",
              !noPadding &&
                (effectiveFullWidth
                  ? "px-4 sm:px-6 lg:px-10 2xl:px-16 py-4"
                  : "px-4 sm:px-6 lg:px-8 py-4"),
            )}
          >
            {insideContent}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default WorkspaceShellFrame;
