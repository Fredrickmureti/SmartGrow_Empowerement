/**
 * SavedViewMenu — lightweight, localStorage-backed saved-view picker for
 * HR list/grid pages (Roster, Approvals, etc.). Stores an arbitrary JSON
 * filter blob under a caller-supplied storage key.
 *
 * Intentionally tiny: no server round-trip, no per-user scoping (the
 * browser profile is the scope). When a richer multi-device view store
 * lands, callers can swap the implementation behind this surface without
 * touching consumers.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SavedView<T> {
  id: string;
  name: string;
  filters: T;
}

interface Props<T> {
  storageKey: string;
  currentFilters: T;
  onApply: (filters: T) => void;
  activeViewId?: string | null;
  onActiveViewIdChange?: (id: string | null) => void;
}

function loadViews<T>(key: string): SavedView<T>[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedView<T>[]) : [];
  } catch {
    return [];
  }
}

function persistViews<T>(key: string, views: SavedView<T>[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(views));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function SavedViewMenu<T>({
  storageKey,
  currentFilters,
  onApply,
  activeViewId,
  onActiveViewIdChange,
}: Props<T>) {
  const [views, setViews] = useState<SavedView<T>[]>(() => loadViews<T>(storageKey));
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    persistViews(storageKey, views);
  }, [storageKey, views]);

  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) ?? null,
    [views, activeViewId],
  );

  const handleSave = useCallback(() => {
    const name = draftName.trim();
    if (!name) return;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const next: SavedView<T> = { id, name, filters: currentFilters };
    setViews((prev) => [...prev, next]);
    onActiveViewIdChange?.(id);
    setDraftName("");
    setSaveOpen(false);
  }, [draftName, currentFilters, onActiveViewIdChange]);

  const handleApply = useCallback(
    (v: SavedView<T>) => {
      onApply(v.filters);
      onActiveViewIdChange?.(v.id);
    },
    [onApply, onActiveViewIdChange],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setViews((prev) => prev.filter((v) => v.id !== id));
      if (activeViewId === id) onActiveViewIdChange?.(null);
    },
    [activeViewId, onActiveViewIdChange],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Bookmark className="h-3.5 w-3.5" />
            <span className="truncate max-w-[140px]">
              {activeView ? activeView.name : "Saved views"}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Saved views
          </DropdownMenuLabel>
          {views.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No saved views yet.
            </div>
          )}
          {views.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={(e) => {
                e.preventDefault();
                handleApply(v);
              }}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 truncate">
                {activeViewId === v.id ? (
                  <Check className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <span className="w-3.5" />
                )}
                <span className="truncate">{v.name}</span>
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(v.id);
                }}
                title="Delete view"
                aria-label={`Delete view ${v.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setSaveOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Save current filters…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-view-name">View name</Label>
            <Input
              id="saved-view-name"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="e.g. Conflicts this week"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!draftName.trim()}>
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SavedViewMenu;
