/**
 * Activity surfaces for a WMS aggregate (Phase 4 §1 — call sites).
 *
 * `<ActivitySection />` renders the aggregate's `business_event_outbox`
 * lifecycle inline on a detail page. `<ActivityHistoryButton />` is the
 * list-page variant: a per-row button that opens the same timeline in a
 * dialog, so board pages get audit access without a detail route.
 *
 * Both wrap the single `<OutboxTimeline />` reader — no page may query
 * `business_event_outbox` directly.
 */
import { useState } from "react";
import { Section } from "@/design-system";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { History } from "lucide-react";
import { OutboxTimeline } from "./OutboxTimeline";

export interface ActivitySectionProps {
  aggregateId: string | null | undefined;
  /** Section heading. Defaults to "Activity". */
  title?: string;
  description?: string;
  limit?: number;
}

export function ActivitySection({
  aggregateId,
  title = "Activity",
  description = "Every lifecycle event emitted for this record, oldest first.",
  limit = 50,
}: ActivitySectionProps) {
  if (!aggregateId) return null;
  return (
    <Section title={title} description={description}>
      <OutboxTimeline aggregateId={aggregateId} limit={limit} />
    </Section>
  );
}

export interface ActivityHistoryButtonProps {
  aggregateId: string;
  label?: string;
  /** Shown in the dialog title, e.g. the record code. */
  recordLabel?: string;
}

export function ActivityHistoryButton({
  aggregateId,
  label = "History",
  recordLabel,
}: ActivityHistoryButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <History className="h-3.5 w-3.5 mr-1" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Activity{recordLabel ? ` — ${recordLabel}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {open ? <OutboxTimeline aggregateId={aggregateId} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ActivitySection;
