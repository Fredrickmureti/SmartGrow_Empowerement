/**
 * ExpandableTextField — compact input for short-to-medium values with
 * an escape hatch to a large dialog for long values. Publishers stop
 * fighting a 200px input to edit a 4-paragraph legal notice.
 */
import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AutoGrowInput } from "./AutoGrowInput";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  monospace?: boolean;
  /** Dialog title. Default "Edit value". */
  dialogTitle?: string;
  /** Minimum expand height for the dialog textarea. */
  expandRows?: number;
  className?: string;
  disabled?: boolean;
}

export function ExpandableTextField({
  value, onChange, placeholder, monospace, dialogTitle = "Edit value",
  expandRows = 12, className, disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  return (
    <div className={cn("relative flex w-full items-center gap-1", className)}>
      <AutoGrowInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        monospace={monospace}
        disabled={disabled}
        className="w-full"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        onClick={() => { setDraft(value); setOpen(true); }}
        aria-label="Expand editor"
        title="Expand editor"
        disabled={disabled}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{dialogTitle}</DialogTitle></DialogHeader>
          <AutoGrowTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            monospace={monospace}
            minRows={expandRows}
            maxHeight={640}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => { onChange(draft); setOpen(false); }}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
