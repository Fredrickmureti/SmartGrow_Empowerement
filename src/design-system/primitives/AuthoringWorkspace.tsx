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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceLayoutMode =
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
  /** Default mode; overridden by persisted value. */
  defaultMode?: WorkspaceLayoutMode;
  /** Optional save handler bound to ⌘S / Ctrl+S. */
  onSave?: () => void;
  className?: string;
}

function persistedKey(workspaceId: string, suffix: string) {
  return `authoring-workspace:${workspaceId}:${suffix}`;
}

function readMode(workspaceId: string, fallback: WorkspaceLayoutMode): WorkspaceLayoutMode {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(persistedKey(workspaceId, "mode"));
  if (raw === "split" || raw === "editor" || raw === "preview" || raw === "bottom" || raw === "focus") {
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

export function AuthoringWorkspace({
  workspaceId,
  toolbar,
  rail,
  editor,
  preview,
  footer,
  defaultMode = "split",
  onSave,
  className,
}: AuthoringWorkspaceProps) {
  const [mode, setMode] = useState<WorkspaceLayoutMode>(() => readMode(workspaceId, defaultMode));
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailOpen(workspaceId));

  // Persist mode / rail state
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "mode"), mode); } catch {}
  }, [workspaceId, mode]);
  useEffect(() => {
    try { window.localStorage.setItem(persistedKey(workspaceId, "rail"), railOpen ? "1" : "0"); } catch {}
  }, [workspaceId, railOpen]);

  const hasPreview = !!preview;
  const hasRail = !!rail;
  // Resolve effective visibility from mode.
  const showEditor = mode !== "preview";
  const showPreview = hasPreview && (mode === "split" || mode === "preview" || mode === "bottom");
  const showRail = hasRail && railOpen && mode !== "focus" && mode !== "preview";

  // Global keyboard shortcuts. Skip when the user is typing into a field
  // so their input keystrokes are never hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();

      // ⌘S — save (allowed even while typing)
      if (key === "s" && !e.shiftKey && onSave) {
        e.preventDefault();
        onSave();
        return;
      }
      if (typing) return;

      // ⌘B — toggle rail
      if (key === "b" && !e.shiftKey && hasRail) {
        e.preventDefault();
        setRailOpen((v) => !v);
        return;
      }
      // ⌘⇧P — toggle preview visibility
      if (key === "p" && e.shiftKey && hasPreview) {
        e.preventDefault();
        setMode((m) => (m === "editor" ? "split" : m === "preview" ? "split" : m === "split" || m === "bottom" ? "editor" : "split"));
        return;
      }
      // ⌘⇧F — focus mode
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setMode((m) => (m === "focus" ? "split" : "focus"));
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPreview, hasRail, onSave]);

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
              value="split"
              icon={<Columns2 className="h-3.5 w-3.5" />}
              label="Split (side by side)"
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
      </div>
    ),
    [hasPreview, hasRail, mode, railOpen],
  );

  // Render the main + preview split. In `bottom` mode we swap to a
  // vertical PanelGroup; in editor/preview/focus modes only one panel
  // renders (no PanelGroup at all — avoids react-resizable-panels
  // remounting when the child set changes).
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
    // Split — side by side
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
  }, [editor, preview, hasPreview, mode, showEditor, showPreview, workspaceId]);

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
          <div className="min-w-0 flex-1 p-3">{mainAndPreview()}</div>
        </div>

        {footer && (
          <div className="border-t bg-background px-3 py-2">{footer}</div>
        )}
      </div>
    </TooltipProvider>
  );
}

function PaneShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-hidden rounded-lg border bg-card">
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
