/**
 * RFQAwardDrawer — the buyer's award decision surface.
 *
 * The buyer picks a winning quotation *per line*, so a split award across
 * several suppliers is the normal case, not an exception. The drawer only
 * collects intent; `rfq_award` re-validates quantities, versions and
 * quotation validity, writes `rfq_awards` + `rfq_award_items` and moves the
 * RFQ to `awarded`.
 */
import { useMemo, useState } from "react";
import { Trophy } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQs, type AwardInput, type RFQWithRelations } from "@/hooks/useRFQs";
import { activeQuotations } from "./rfqView";

const NONE = "__none__";

interface Props {
  rfq: RFQWithRelations | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RFQAwardDrawer({ rfq, open, onOpenChange }: Props) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const { awardRFQAsync, isAwarding } = useRFQs();
  const currency = rfq?.currency || baseCurrency;

  const quotes = useMemo(() => activeQuotations(rfq), [rfq]);
  const lines = useMemo(
    () => (rfq?.items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [rfq],
  );

  // line id -> quotation item id
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState("");

  const offersFor = (lineId: string) =>
    quotes
      .flatMap((q) =>
        (q.items ?? [])
          .filter((li) => li.rfq_item_id === lineId)
          .map((li) => ({ quotation: q, item: li })),
      )
      .sort((a, b) => a.item.unit_price - b.item.unit_price);

  const selectBestOverall = () => {
    const next: Record<string, string> = {};
    for (const line of lines) {
      if (!line.id) continue;
      const best = offersFor(line.id)[0];
      if (best) next[line.id] = best.item.id;
    }
    setPicks(next);
  };

  const awards: AwardInput[] = useMemo(() => {
    const byQuotation = new Map<string, AwardInput>();
    for (const line of lines) {
      if (!line.id) continue;
      const pickedItemId = picks[line.id];
      if (!pickedItemId || pickedItemId === NONE) continue;
      const offer = offersFor(line.id).find((o) => o.item.id === pickedItemId);
      if (!offer) continue;
      const qty = Number(qtys[line.id] ?? line.quantity);
      if (!qty || qty <= 0) continue;
      const entry = byQuotation.get(offer.quotation.id) ?? {
        quotation_id: offer.quotation.id,
        lines: [],
      };
      entry.lines.push({ quotation_item_id: pickedItemId, awarded_quantity: qty });
      byQuotation.set(offer.quotation.id, entry);
    }
    return [...byQuotation.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, qtys, lines, quotes]);

  const awardedValue = useMemo(() => {
    let sum = 0;
    for (const line of lines) {
      if (!line.id) continue;
      const pickedItemId = picks[line.id];
      if (!pickedItemId) continue;
      const offer = offersFor(line.id).find((o) => o.item.id === pickedItemId);
      if (!offer) continue;
      sum += offer.item.unit_price * Number(qtys[line.id] ?? line.quantity);
    }
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, qtys, lines, quotes]);

  const submit = async () => {
    if (!rfq || awards.length === 0) return;
    await awardRFQAsync({ rfqId: rfq.id, awards, justification });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Award {rfq?.rfq_number}</SheetTitle>
          <SheetDescription>
            Choose a winning quotation per line. Lines left unawarded stay unsourced and can be
            awarded in a later round.
          </SheetDescription>
        </SheetHeader>

        {quotes.length === 0 ? (
          <p className="py-8 text-sm text-muted-foreground">
            No live quotations to award yet.
          </p>
        ) : (
          <div className="space-y-4 py-4">
            <Button variant="outline" size="sm" onClick={selectBestOverall}>
              <Trophy className="mr-2 h-4 w-4" />
              Pick lowest price per line
            </Button>

            {lines.map((line) => {
              const offers = line.id ? offersFor(line.id) : [];
              return (
                <div key={line.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{line.description}</p>
                      <p className="text-xs text-muted-foreground">
                        Requested {line.quantity}
                        {line.target_price != null &&
                          ` · target ${formatCurrency(line.target_price, currency)}`}
                      </p>
                    </div>
                    <Input
                      className="w-24"
                      type="number"
                      min="0"
                      value={qtys[line.id ?? ""] ?? String(line.quantity)}
                      onChange={(e) =>
                        setQtys((p) => ({ ...p, [line.id as string]: e.target.value }))
                      }
                    />
                  </div>
                  <Select
                    value={picks[line.id ?? ""] ?? NONE}
                    onValueChange={(v) =>
                      setPicks((p) => ({ ...p, [line.id as string]: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Not awarded" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not awarded</SelectItem>
                      {offers.map((o) => (
                        <SelectItem key={o.item.id} value={o.item.id}>
                          {o.quotation.supplier?.name ?? "Supplier"} ·{" "}
                          {formatCurrency(o.item.unit_price, o.quotation.currency)}
                          {o.quotation.lead_time_days != null &&
                            ` · ${o.quotation.lead_time_days}d`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {offers.length === 0 && (
                    <p className="text-xs text-muted-foreground">No supplier quoted this line.</p>
                  )}
                </div>
              );
            })}

            <div className="space-y-2">
              <Label>Award justification</Label>
              <Textarea
                rows={3}
                placeholder="Why these suppliers won — kept on the audit trail."
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </div>
          </div>
        )}

        <SheetFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {awards.length} supplier(s) ·{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {formatCurrency(awardedValue, currency)}
            </span>
          </span>
          <Button onClick={submit} disabled={awards.length === 0 || isAwarding}>
            Confirm award
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
