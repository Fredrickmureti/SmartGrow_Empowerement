/**
 * DisposeAssetSheet — record disposal of a Fixed Asset. Mounted on
 * DetailSheet. URL-driven behind `?sheet=dispose&id=<asset-uuid>`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import {
  DetailSheet,
  FieldGrid,
  FieldCell,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { useFixedAssets, type FixedAsset } from "@/hooks/useFixedAssets";
import { useCurrency } from "@/hooks/useCurrency";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: FixedAsset | null;
}

export function DisposeAssetSheet({ open, onOpenChange, asset }: Props) {
  const { disposeAsset } = useFixedAssets();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [form, setForm] = useState({
    disposal_date: format(new Date(), "yyyy-MM-dd"),
    disposal_amount: 0,
    disposal_method: "sale",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open && asset) {
      setForm({
        disposal_date: format(new Date(), "yyyy-MM-dd"),
        disposal_amount: asset.book_value || 0,
        disposal_method: "sale",
        notes: "",
      });
    }
  }, [open, asset]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!asset) return;
    setIsSubmitting(true);
    try {
      await disposeAsset(
        asset.id,
        form.disposal_date,
        form.disposal_amount,
        form.disposal_method,
      );
      toast({ title: "Asset disposed successfully" });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const gainLoss = asset
    ? form.disposal_amount - (asset.book_value || 0)
    : 0;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Dispose asset"
      description={asset ? `Record the disposal of ${asset.name}` : undefined}
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="dispose-asset-form"
                disabled={isSubmitting || !asset}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Dispose asset
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form
        id="dispose-asset-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="d-date">Disposal date *</Label>
            <Input
              id="d-date"
              type="date"
              value={form.disposal_date}
              onChange={(e) =>
                setForm({ ...form, disposal_date: e.target.value })
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="d-amount">Disposal amount</Label>
            <Input
              id="d-amount"
              type="number"
              min="0"
              step="0.01"
              value={form.disposal_amount}
              onChange={(e) =>
                setForm({
                  ...form,
                  disposal_amount: parseFloat(e.target.value) || 0,
                })
              }
            />
          </div>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="d-method">Disposal method</Label>
              <Select
                value={form.disposal_method}
                onValueChange={(v) => setForm({ ...form, disposal_method: v })}
              >
                <SelectTrigger id="d-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sale">Sale</SelectItem>
                  <SelectItem value="scrap">Scrap</SelectItem>
                  <SelectItem value="donation">Donation</SelectItem>
                  <SelectItem value="theft">Theft/Loss</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="d-notes">Notes</Label>
              <Textarea
                id="d-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
              />
            </div>
          </FieldCell>
        </FieldGrid>

        {asset && (
          <Card className="bg-muted/50">
            <CardContent className="p-4 text-sm">
              <div className="flex justify-between">
                <span>Book value:</span>
                <span className="font-medium">
                  {formatCurrency(asset.book_value || 0)}
                </span>
              </div>
              <div className="flex justify-between mt-1">
                <span>Gain/Loss:</span>
                <span
                  className={
                    gainLoss >= 0
                      ? "text-primary font-medium"
                      : "text-destructive font-medium"
                  }
                >
                  {formatCurrency(gainLoss)}
                </span>
              </div>
            </CardContent>
          </Card>
        )}
      </form>
    </DetailSheet>
  );
}

export default DisposeAssetSheet;
