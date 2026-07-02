/**
 * SavedViewMenu — compact dropdown that lists the current user's saved
 * filter presets for a given Attendance surface (today | approvals | reports)
 * and lets them save the current filter set as a new view, set a default,
 * or delete an existing view.
 *
 * Stateless about the actual filter shape: the host passes `currentFilters`
 * (whatever it cares about) and `onApply(filters)` which it interprets.
 */
import { useState } from "react";
import { Bookmark, BookmarkPlus, Star, StarOff, Trash2, Check } from "lucide-react";
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
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  useAttendanceSavedViews,
  type SavedViewScope,
} from "@/hooks/hr/useAttendanceSavedViews";

interface Props {
  scope: SavedViewScope;
  currentFilters: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
  /** Optional label override for the trigger. */
  label?: string;
}

export function SavedViewMenu({ scope, currentFilters, onApply, label }: Props) {
  const { views, save, remove, setDefault } = useAttendanceSavedViews(scope);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1) return;
    try {
      await save.mutateAsync({
        name: trimmed,
        filters: currentFilters,
        isDefault: makeDefault,
      });
      toast.success(`Saved view "${trimmed}"`);
      setOpen(false);
      setName("");
      setMakeDefault(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save view");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Bookmark className="h-3.5 w-3.5" />
            {label ?? "Views"}
            {views.length > 0 && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                {views.length}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Saved views
          </DropdownMenuLabel>
          {views.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No saved views yet. Save the current filters below.
            </div>
          )}
          {views.map((v) => (
            <DropdownMenuItem
              key={v.id}
              onSelect={(e) => {
                e.preventDefault();
                onApply(v.filters);
                toast.success(`Applied "${v.name}"`);
              }}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 truncate">
                {v.is_default && <Check className="h-3 w-3 text-primary" />}
                <span className="truncate">{v.name}</span>
              </span>
              <span className="flex items-center gap-1 opacity-70">
                <button
                  type="button"
                  className="hover:text-primary"
                  title={v.is_default ? "Default" : "Set as default"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!v.is_default) setDefault.mutate(v.id);
                  }}
                >
                  {v.is_default ? <Star className="h-3 w-3" /> : <StarOff className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  className="hover:text-destructive"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove.mutate(v.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <BookmarkPlus className="h-3.5 w-3.5 mr-2" />
            Save current filters…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        size="md"
        title="Save view"
        description="Save the current filters as a reusable view for this surface."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={save.isPending || name.trim().length < 1}
            >
              Save
            </Button>
          </>
        }
      >
        <WorkflowSheetSection
          number={1}
          title="Identity"
          right={
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={makeDefault}
                onCheckedChange={(c) => setMakeDefault(!!c)}
              />
              Default for {scope}
            </label>
          }
        >
          <WorkflowField label="Name" htmlFor="saved-view-name" required>
            <Input
              id="saved-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My team — late today"
              autoFocus
            />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>
    </>
  );
}
