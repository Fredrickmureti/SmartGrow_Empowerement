/**
 * AuthoringWorkspace — reusable IDE-style shell for the ERP's advanced
 * authoring surfaces (Localization Editor, template designers, future
 * report/formula editors). Composes three regions: a left rail (outline
 * / tree), a main editor, and a preview. The preview is dockable
 * (right / bottom / hidden / preview-only) and every split ratio is
 * persisted per workspace id via react-resizable-panels' `autoSaveId`.
 *
 * The goal is to stop treating an 8-hour-per-day authoring surface as
 * a settings page. Publishers get:
 *
 *  - Split · Editor · Preview · Focus · Preview-bottom layout modes
 *  - Resizable, persisted panel sizes
 *  - Collapsible left rail (outline)
 *  - Keyboard shortcuts (⌘B rail · ⌘⇧P preview · ⌘⇧F focus · ⌘S save)
 *
 * Consumers pass the toolbar, rail, editor and preview slots; the
 * shell owns layout state, persistence and shortcuts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Columns2,
  PanelLeft,
  PanelLeftClose,
  Rows2,
  SquarePen,
  Eye,
  Focus as FocusIcon,
  ExternalLink,
  PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceLayoutMode =
  | "overlay"        // preview slides in over a fixed-width editor (default)
  | "split"          // editor + preview side by side (default)
  | "editor"         // preview hidden
  | "preview"        // editor hidden
  | "bottom"         // preview docked under editor (landscape docs)
  | "focus";         // rail + preview hidden, editor takes everything

export type WorkspaceNavDirection = "next" | "prev";


interface AuthoringWorkspaceProps {
  /** Stable id — used for persisted panel sizes and layout mode. */
  workspaceId: string;
  /** Command ribbon rendered above the panels. */
  toolbar?: ReactNode;
  /** Left rail — outline / tree. Optional. */
  rail?: ReactNode;
  /** Main editor content. Required. */
  editor: ReactNode;
  /** Preview content. Optional; omitted → layout collapses to editor-only. */
  preview?: ReactNode;
  /** Sticky footer (save bar). Optional. */
  footer?: ReactNode;
  /** Status strip rendered along the bottom (dirty / validation / hints). */
  statusBar?: ReactNode;
  /** Default mode; overridden by persisted value. */
  defaultMode?: WorkspaceLayoutMode;
  /** Optional save handler bound to ⌘S / Ctrl+S. */
  onSave?: () => void;
  /** Optional J / K node navigation (only fires when not typing). */
  onNavigateNode?: (direction: WorkspaceNavDirection) => void;
  /**
   * Optional pop-out. When the handler returns the child `Window` (or a
   * Promise of it), the workspace enters "detached preview" mode: the
   * in-app preview pane is hidden so the editor gets 100 % of the
   * surface, and a re-attach control replaces the pop-out button.
   * When the child window closes the workspace auto-restores the
   * inline preview.
   */
  onPopOutPreview?: () => Window | null | void | Promise<Window | null | void>;
  className?: string;
}


// Bump the version suffix when layout semantics change so old persisted
// split ratios / drawer sizes don't keep users trapped in cramped previews.
const PERSIST_VERSION = "v3";
function persistedKey(workspaceId: string, suffix: string) {
  return `authoring-workspace:${PERSIST_VERSION}:${workspaceId}:${suffix}`;
}

function readMode(workspaceId: string, fallback: WorkspaceLayoutMode): WorkspaceLayoutMode {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(persistedKey(workspaceId, "mode"));
  if (
    raw === "overlay" || raw === "split" || raw === "editor" ||
    raw === "preview" || raw === "bottom" || raw === "focus"
  ) {
    return raw;
  }
  return fallback;
}

function readRailOpen(workspaceId: string): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(persistedKey(workspaceId, "rail"));
  if (raw === "1") return true;
  if (raw === "0") return false;
  return true;
}

function readNumber(workspaceId: string, suffix: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(persistedKey(workspaceId, suffix));
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function AuthoringWorkspace({
  workspaceId,
  toolbar,
  rail,
  editor,
  preview,
  footer,
  statusBar,
  defaultMode = "overlay",
  onSave,
  onNavigateNode,
  onPopOutPreview,
  className,
}: AuthoringWorkspaceProps) {
  const [mode, setMode] = useState<WorkspaceLayoutMode>(() => readMode(workspaceId, defaultMode));
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailOpen(workspaceId));
  // Overlay-mode preview width (px). Editor keeps its natural width; only
  // the preview drawer resizes.
  const [overlayPreviewPx, setOverlayPreviewPx] = useState<number>(
    () => readNumber(workspaceId, "overlay-preview-px", 760),
  );
  // Bottom-mode preview height (px). It is an overlay sheet, not a vertical
  // split, so dragging grows the preview over the editor instead of shrinking
  // the editor into a tiny strip.
  const [bottomPreviewPx, setBottomPreviewPx] = useState<number>(
    () => readNumber(workspaceId, "bottom-preview-px", 760),
  );

  // Persist mode / rail state
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "mode"), mode); } catch {}
  }, [workspaceId, mode]);
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "rail"), railOpen ? "1" : "0"); } catch {}
  }, [workspaceId, railOpen]);
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "overlay-preview-px"), String(overlayPreviewPx)); } catch {}
  }, [workspaceId, overlayPreviewPx]);
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "bottom-preview-px"), String(bottomPreviewPx)); } catch {}
  }, [workspaceId, bottomPreviewPx]);

  // Detached-preview window (pop-out). While non-null the inline preview
  // is suppressed so the editor gets the whole surface and the toolbar
  // shows a re-attach control instead of the pop-out button. A cheap
  // poll auto-clears the state when the child window is closed by the
  // user (there's no cross-window "closed" event).
  const [detachedWindow, setDetachedWindow] = useState<Window | null>(null);
  useEffect(() => {
    if (!detachedWindow) return;
    const id = window.setInterval(() => {
      if (detachedWindow.closed) {
        setDetachedWindow(null);
      }
    }, 700);
    return () => window.clearInterval(id);
  }, [detachedWindow]);
  // Best-effort: close the child when the parent unloads so a stale
  // pop-out doesn't linger after the publisher navigates away.
  useEffect(() => {
    if (!detachedWindow) return;
    const onUnload = () => { try { detachedWindow.close(); } catch { /* ignore */ } };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [detachedWindow]);

  const isDetached = !!detachedWindow;
  const hasPreview = !!preview;
  const hasRail = !!rail;
  // Resolve effective visibility from mode. When the preview is detached
  // into its own window the inline preview is suppressed entirely so the
  // editor gets 100 % of the workspace surface.
  const showEditor = isDetached ? true : mode !== "preview";
  const showPreview = !isDetached && hasPreview && (mode === "overlay" || mode === "split" || mode === "preview" || mode === "bottom");
  const showRail = hasRail && railOpen && mode !== "focus" && (isDetached || mode !== "preview");

  // Global keyboard shortcuts. Skip when the user is typing into a field
  // so their input keystrokes are never hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;

      // ⌘S — save (allowed even while typing)
      if (meta && e.key.toLowerCase() === "s" && !e.shiftKey && onSave) {
        e.preventDefault();
        onSave();
        return;
      }
      if (typing) return;

      // J / K — next / previous node (no modifier). Ignore inside inputs.
      if (!meta && onNavigateNode) {
        if (e.key === "j" || e.key === "ArrowDown" && e.altKey) {
          e.preventDefault();
          onNavigateNode("next");
          return;
        }
        if (e.key === "k" || e.key === "ArrowUp" && e.altKey) {
          e.preventDefault();
          onNavigateNode("prev");
          return;
        }
      }

      if (!meta) return;
      const key = e.key.toLowerCase();

      // ⌘B — toggle rail
      if (key === "b" && !e.shiftKey && hasRail) {
        e.preventDefault();
        setRailOpen((v) => !v);
        return;
      }
      // ⌘⇧P — toggle preview visibility
      if (key === "p" && e.shiftKey && hasPreview) {
        e.preventDefault();
        setMode((m) => {
          if (m === "editor") return "overlay";
          if (m === "preview") return "overlay";
          if (m === "overlay" || m === "split" || m === "bottom") return "editor";
          return "overlay";
        });
        return;
      }
      // ⌘⇧F — focus mode
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setMode((m) => (m === "focus" ? "overlay" : "focus"));
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPreview, hasRail, onSave, onNavigateNode]);


  const layoutControls = useMemo(
    () => (
      <div className="ml-auto flex items-center gap-1">
        {hasRail && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setRailOpen((v) => !v)}
                aria-pressed={railOpen}
                aria-label="Toggle outline rail"
              >
                {railOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle outline (⌘B)</TooltipContent>
          </Tooltip>
        )}
        {hasPreview && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <LayoutModeButton
              current={mode}
              value="editor"
              icon={<SquarePen className="h-3.5 w-3.5" />}
              label="Editor only"
              onSelect={setMode}
            />
            <LayoutModeButton
              current={mode}
              value="overlay"
              icon={<PanelRightOpen className="h-3.5 w-3.5" />}
              label="Preview drawer (editor keeps width)"
              onSelect={setMode}
            />
            <LayoutModeButton
              current={mode}
              value="split"
              icon={<Columns2 className="h-3.5 w-3.5" />}
              label="Wide side preview"
              onSelect={setMode}
            />
            <LayoutModeButton
              current={mode}
              value="bottom"
              icon={<Rows2 className="h-3.5 w-3.5" />}
              label="Preview at bottom"
              onSelect={setMode}
            />
            <LayoutModeButton
              current={mode}
              value="preview"
              icon={<Eye className="h-3.5 w-3.5" />}
              label="Preview only"
              onSelect={setMode}
            />
            <LayoutModeButton
              current={mode}
              value="focus"
              icon={<FocusIcon className="h-3.5 w-3.5" />}
              label="Focus mode (⌘⇧F)"
              onSelect={setMode}
            />
          </>
        )}
        {onPopOutPreview && hasPreview && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={onPopOutPreview}
                  aria-label="Open preview in a new window"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Pop out preview</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    ),
    [hasPreview, hasRail, mode, railOpen, onPopOutPreview],
  );

  // Overlay-mode drag handling — moves ONLY the preview edge; editor keeps
  // its width. Drag past the collapse threshold hides the preview entirely
  // (mode → "editor"), leaving only a floating restore tab.
  const COLLAPSE_PX = 140;
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const onOverlayHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const container = overlayContainerRef.current;
    if (!container) return;
    target.setPointerCapture(e.pointerId);
    const containerRect = container.getBoundingClientRect();
    let latest = overlayPreviewPx;
    const move = (ev: PointerEvent) => {
      const fromRight = containerRect.right - ev.clientX;
      latest = Math.max(0, Math.min(fromRight, containerRect.width));
      setOverlayPreviewPx(Math.max(240, latest));
    };
    const up = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (latest < COLLAPSE_PX) {
        // Snap-collapse: hide preview but remember a sensible restore size.
        setOverlayPreviewPx(Math.max(overlayPreviewPx, 560));
        setMode("editor");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [overlayPreviewPx]);

  const onBottomHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const container = overlayContainerRef.current;
    if (!container) return;
    target.setPointerCapture(e.pointerId);
    const containerRect = container.getBoundingClientRect();
    let latest = bottomPreviewPx;
    const move = (ev: PointerEvent) => {
      const fromBottom = containerRect.bottom - ev.clientY;
      latest = Math.max(0, Math.min(fromBottom, containerRect.height));
      setBottomPreviewPx(Math.max(200, latest));
    };
    const up = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (latest < COLLAPSE_PX) {
        setBottomPreviewPx(Math.max(bottomPreviewPx, 480));
        setMode("editor");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [bottomPreviewPx]);


  // Render the main + preview split. In `bottom` mode we swap to a
  // vertical PanelGroup; in `overlay` mode the editor keeps its natural
  // width and the preview docks on the right with a drag handle that
  // moves ONLY the preview edge (no seesaw); in editor/preview/focus
  // modes only one panel renders.
  const mainAndPreview = useCallback(() => {
    if (!hasPreview || !showPreview) {
      // Editor only (also covers focus mode).
      return showEditor ? <PaneShell>{editor}</PaneShell> : null;
    }
    if (!showEditor) {
      return <PaneShell>{preview}</PaneShell>;
    }
    const isBottom = mode === "bottom";
    const isWideSide = mode === "split";
    // Overlay — editor keeps its FULL natural width. Preview drawer
    // floats over the editor (right or bottom), and the drag handle is
    // anchored to the preview edge so resizing only moves the preview —
    // never the editor.
    return (
      <div ref={overlayContainerRef} className="relative flex h-full w-full min-w-0 items-stretch">
        <div className="min-w-0 flex-1">
          <PaneShell>{editor}</PaneShell>
        </div>
        {isBottom ? (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] bg-gradient-to-t from-background/45 to-transparent"
              style={{ height: `min(100%, ${bottomPreviewPx + 24}px)` }}
            />
            <div
              className="absolute inset-x-0 bottom-0 z-[2] flex flex-col shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)]"
              style={{ height: `min(100%, ${bottomPreviewPx}px)` }}
            >
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize bottom preview"
                onPointerDown={onBottomHandlePointerDown}
                className="group relative -mt-1 h-2 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-primary/30"
                title="Drag to resize preview"
              >
                <div className="pointer-events-none absolute left-0 top-1/2 h-0.5 w-full -translate-y-1/2 rounded bg-border/70 group-hover:bg-primary/70" />
              </div>
              <div className="min-h-0 flex-1">
                <PaneShell>{preview}</PaneShell>
              </div>
            </div>
          </>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 z-[1] bg-gradient-to-l from-background/40 to-transparent"
              style={{ width: `min(100%, ${overlayPreviewPx + 24}px)` }}
            />
            <div
              className="absolute inset-y-0 right-0 z-[2] flex items-stretch shadow-[-8px_0_24px_-12px_rgba(0,0,0,0.25)]"
              style={{ width: `min(100%, ${isWideSide ? Math.max(overlayPreviewPx, 900) : overlayPreviewPx}px)` }}
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize preview drawer"
                onPointerDown={onOverlayHandlePointerDown}
                className="group relative -ml-1 w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30"
                title="Drag to resize preview"
              >
                <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded bg-border/70 group-hover:bg-primary/70" />
              </div>
              <div className="min-w-0 flex-1">
                <PaneShell>{preview}</PaneShell>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }, [editor, preview, hasPreview, mode, showEditor, showPreview, overlayPreviewPx, bottomPreviewPx, onOverlayHandlePointerDown, onBottomHandlePointerDown]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn("flex h-full min-h-0 w-full flex-col bg-background", className)}>
        {(toolbar || hasPreview || hasRail) && (
          <div className="flex items-center gap-1 border-b bg-card/70 px-3 py-1.5">
            {toolbar}
            {layoutControls}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {showRail && (
            <>
              <aside className="w-56 shrink-0 border-r bg-card/40 xl:w-64 2xl:w-72">
                <div className="h-full min-h-0 overflow-hidden">{rail}</div>
              </aside>
            </>
          )}
          <div className="relative min-w-0 min-h-0 flex-1">
            {mainAndPreview()}
            {hasPreview && mode === "editor" && (
              <button
                type="button"
                onClick={() => setMode("overlay")}
                className="absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-l-md border border-r-0 bg-card px-2 py-3 text-[11px] font-medium text-muted-foreground shadow-md hover:bg-accent hover:text-foreground"
                aria-label="Show preview"
                title="Show preview"
              >
                <Eye className="h-3.5 w-3.5" />
                <span className="[writing-mode:vertical-rl] rotate-180">Preview</span>
              </button>
            )}
          </div>
        </div>

        {statusBar && (
          <div className="border-t bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
            {statusBar}
          </div>
        )}
        {footer && (
          <div className="border-t bg-background px-3 py-2">{footer}</div>
        )}

      </div>
    </TooltipProvider>
  );
}

function PaneShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border bg-card">
      {children}
    </div>
  );
}

function LayoutModeButton({
  current,
  value,
  icon,
  label,
  onSelect,
}: {
  current: WorkspaceLayoutMode;
  value: WorkspaceLayoutMode;
  icon: ReactNode;
  label: string;
  onSelect: (v: WorkspaceLayoutMode) => void;
}) {
  const active = current === value;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onSelect(value)}
          aria-pressed={active}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default AuthoringWorkspace;
