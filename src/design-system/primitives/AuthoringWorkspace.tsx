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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
  /** Optional pop-out — surfaces an "open in new window" button in the toolbar. */
  onPopOutPreview?: () => void;
  className?: string;
}


function persistedKey(workspaceId: string, suffix: string) {
  return `authoring-workspace:${workspaceId}:${suffix}`;
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
    () => readNumber(workspaceId, "overlay-preview-px", 520),
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

  const hasPreview = !!preview;
  const hasRail = !!rail;
  // Resolve effective visibility from mode.
  const showEditor = mode !== "preview";
  const showPreview = hasPreview && (mode === "overlay" || mode === "split" || mode === "preview" || mode === "bottom");
  const showRail = hasRail && railOpen && mode !== "focus" && mode !== "preview";

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
              label="Split 50/50 (resizes editor too)"
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
  // its width. Uses a pointer capture so the drag survives fast moves.
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const onOverlayHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const container = overlayContainerRef.current;
    if (!container) return;
    target.setPointerCapture(e.pointerId);
    const containerRect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const fromRight = containerRect.right - ev.clientX;
      const clamped = Math.max(280, Math.min(fromRight, Math.max(300, containerRect.width - 480)));
      setOverlayPreviewPx(clamped);
    };
    const up = () => {
      target.releasePointerCapture(e.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

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
    if (mode === "bottom") {
      return (
        <ResizablePanelGroup
          direction="vertical"
          autoSaveId={persistedKey(workspaceId, "main-v")}
          className="h-full w-full gap-0"
        >
          <ResizablePanel defaultSize={60} minSize={20}>
            <PaneShell>{editor}</PaneShell>
          </ResizablePanel>
          <ResizableHandle withHandle className="my-2" />
          <ResizablePanel defaultSize={40} minSize={15}>
            <PaneShell>{preview}</PaneShell>
          </ResizablePanel>
        </ResizablePanelGroup>
      );
    }
    if (mode === "split") {
      // 50/50 seesaw — editor and preview share space; user opts in.
      return (
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId={persistedKey(workspaceId, "main-h")}
          className="h-full w-full gap-0"
        >
          <ResizablePanel defaultSize={60} minSize={30}>
            <PaneShell>{editor}</PaneShell>
          </ResizablePanel>
          <ResizableHandle withHandle className="mx-2" />
          <ResizablePanel defaultSize={40} minSize={20}>
            <PaneShell>{preview}</PaneShell>
          </ResizablePanel>
        </ResizablePanelGroup>
      );
    }
    // Overlay — editor keeps natural width, preview drawer floats on right.
    return (
      <div ref={overlayContainerRef} className="relative flex h-full w-full min-w-0 items-stretch gap-0">
        <div className="min-w-0 flex-1">
          <PaneShell>{editor}</PaneShell>
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview drawer"
          onPointerDown={onOverlayHandlePointerDown}
          className="group relative mx-1 w-1.5 shrink-0 cursor-col-resize rounded bg-border/60 transition-colors hover:bg-primary/60"
          title="Drag to resize preview"
        >
          <div className="pointer-events-none absolute inset-y-0 -inset-x-1" />
        </div>
        <div
          className="shrink-0"
          style={{ width: `${overlayPreviewPx}px`, maxWidth: "80%" }}
        >
          <PaneShell>{preview}</PaneShell>
        </div>
      </div>
    );
  }, [editor, preview, hasPreview, mode, showEditor, showPreview, workspaceId, overlayPreviewPx, onOverlayHandlePointerDown]);

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
              <aside className="w-64 shrink-0 border-r bg-card/40">
                <div className="h-full min-h-0 overflow-hidden">{rail}</div>
              </aside>
            </>
          )}
          <div className="min-w-0 min-h-0 flex-1 p-3">{mainAndPreview()}</div>
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
