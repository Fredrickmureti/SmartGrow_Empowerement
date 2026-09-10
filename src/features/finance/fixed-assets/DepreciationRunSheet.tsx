/**
 * DepreciationRunSheet — preview and post monthly depreciation entries
 * for all active assets. Mounted on DetailSheet. URL-driven behind
 * `?sheet=depreciation`.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  useDepreciationRun,
  DEPRECIATION_BLOCKER_LABEL,
  type DepreciationPreviewItem,
} from "@/hooks/useDepreciationRun";
import { useCurrency } from "@/hooks/useCurrency";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DepreciationRunSheet({ open, onOpenChange }: Props) {
  const { previewDepreciation, runDepreciation, isRunning, isPreviewing } =
    useDepreciationRun();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [period, setPeriod] = useState(format(new Date(), "yyyy-MM"));
  const [preview, setPreview] = useState<DepreciationPreviewItem[]>([]);
  // The server decides which assets are eligible; the screen only reports it.
  const postable = preview.filter((p) => !p.blocker && p.monthlyDepreciation > 0);

  const loadPreview = async (p: string) => {
    try {
      const rows = await previewDepreciation(p + "-01");
      setPreview(rows);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (open) loadPreview(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleRun = async () => {
    try {
      const result = await runDepreciation(period + "-01");
      if (result.errors.length > 0) {
        toast({
          title: "Depreciation completed with warnings",
          description: result.errors[0],
          variant: "destructive",
        });
      } else {
        toast({ title: "Depreciation posted successfully" });
      }
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Run depreciation"
      description="Post monthly depreciation entries for all active assets."
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isRunning}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRun}
                disabled={isRunning || preview.length === 0}
              >
                {isRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Post depreciation
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="dep-period">Period</Label>
          <Input
            id="dep-period"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadPreview(period)}
          disabled={isPreviewing}
        >
          {isPreviewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Preview
        </Button>

        {preview.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Book value</TableHead>
                <TableHead className="text-right">Depreciation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.map((item) => (
                <TableRow key={item.assetId}>
                  <TableCell className="font-medium">
                    {item.assetNumber} — {item.assetName}
                  </TableCell>
                  <TableCell className="capitalize">
                    {item.method.replace("_", " ")}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(item.bookValue)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(item.monthlyDepreciation)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={3} className="font-bold text-right">
                  Total
                </TableCell>
                <TableCell className="text-right font-bold">
                  {formatCurrency(
                    preview.reduce((s, i) => s + i.monthlyDepreciation, 0),
                  )}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}

        {preview.length === 0 && !isPreviewing && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Click Preview to see depreciation amounts before posting.
          </p>
        )}
      </div>
    </DetailSheet>
  );
}

export default DepreciationRunSheet;
