/**
 * GeneratePeriodsSheet — bulk-generate 12 monthly (or 4 quarterly) + 1
 * yearly fiscal period at a time. Same content that used to live in the
 * inline `<Dialog>` on `FiscalPeriods.tsx`, promoted to the DS
 * `DetailSheet` so the interaction language matches the rest of Finance.
 *
 * URL-driven behind `?sheet=generate`.
 */
import { useMemo, useState } from "react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { Eye, Info, Loader2 } from "lucide-react";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useQuery } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function GeneratePeriodsSheet({ open, onOpenChange }: Props) {
  const { currentOrg } = useOrganization();
  const { periods, generatePeriods } = useFiscalPeriods();

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);
  const [generateYear, setGenerateYear] = useState(currentYear.toString());
  const [generateType, setGenerateType] = useState<"month" | "quarter">("month");

  const { data: orgFiscalConfig } = useQuery({
    queryKey: ["org-fiscal-config", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return { fiscal_year_start: 1 };
      const { data } = await supabase
        .from("businesses")
        .select("fiscal_year_start")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      return { fiscal_year_start: data?.fiscal_year_start || 1 };
    },
    enabled: !!currentOrg?.id && open,
  });

  const fiscalStartMonth = orgFiscalConfig?.fiscal_year_start || 1;

  const previewPeriods = useMemo(() => {
    const year = parseInt(generateYear);
    const startMonth = fiscalStartMonth - 1;
    const fyStartDate = new Date(year, startMonth, 1);
    const items: Array<{ name: string; start: string; end: string }> = [];

    if (generateType === "month") {
      for (let i = 0; i < 12; i++) {
        const monthDate = new Date(
          fyStartDate.getFullYear(),
          fyStartDate.getMonth() + i,
          1,
        );
        items.push({
          name: format(monthDate, "MMMM yyyy"),
          start: format(startOfMonth(monthDate), "MMM d, yyyy"),
          end: format(endOfMonth(monthDate), "MMM d, yyyy"),
        });
      }
    } else {
      for (let q = 0; q < 4; q++) {
        const qStart = new Date(
          fyStartDate.getFullYear(),
          fyStartDate.getMonth() + q * 3,
          1,
        );
        const qEnd = new Date(
          fyStartDate.getFullYear(),
          fyStartDate.getMonth() + q * 3 + 3,
          0,
        );
        items.push({
          name: `Q${q + 1} FY${year}`,
          start: format(qStart, "MMM d, yyyy"),
          end: format(qEnd, "MMM d, yyyy"),
        });
      }
    }

    const fyEnd = new Date(
      year + (fiscalStartMonth === 1 ? 0 : 1),
      fiscalStartMonth === 1 ? 11 : fiscalStartMonth - 2 + 1,
      0,
    );
    items.push({
      name: `FY ${year}`,
      start: format(fyStartDate, "MMM d, yyyy"),
      end: format(fyEnd, "MMM d, yyyy"),
    });

    return items;
  }, [generateYear, generateType, fiscalStartMonth]);

  const existingPeriodsForYear = useMemo(() => {
    const year = parseInt(generateYear);
    return periods.filter((p) => p.name.includes(year.toString())).length;
  }, [generateYear, periods]);

  const isGenerating = generatePeriods.isPending;

  const handleGenerate = async () => {
    await generatePeriods.mutateAsync({
      year: parseInt(generateYear),
      periodType: generateType,
    });
    onOpenChange(false);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Generate fiscal periods"
      description={
        <>
          Create fiscal periods for a year. Existing periods will not be duplicated.
          {fiscalStartMonth !== 1 && (
            <span className="block mt-1 font-medium text-foreground">
              Fiscal year starts in {MONTH_NAMES[fiscalStartMonth - 1]}.
            </span>
          )}
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isGenerating}
              >
                Cancel
              </Button>
              <Button onClick={handleGenerate} disabled={isGenerating}>
                {isGenerating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Year</Label>
          <Select value={generateYear} onValueChange={setGenerateYear}>
            <SelectTrigger>
              <SelectValue placeholder="Select year" />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((year) => (
                <SelectItem key={year} value={year.toString()}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Period type</Label>
          <Select
            value={generateType}
            onValueChange={(v) => setGenerateType(v as "month" | "quarter")}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Monthly (12 periods)</SelectItem>
              <SelectItem value="quarter">Quarterly (4 periods)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {existingPeriodsForYear > 0 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Existing periods</AlertTitle>
            <AlertDescription className="text-xs">
              {existingPeriodsForYear} period(s) already exist for {generateYear}.
              Duplicates will be skipped.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <Label className="text-sm font-medium">
              Preview ({previewPeriods.length} periods)
            </Label>
          </div>
          <ScrollArea className="h-56 rounded-md border">
            <div className="p-2 space-y-1">
              {previewPeriods.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-muted/50"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground">
                    {p.start} — {p.end}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </DetailSheet>
  );
}

export default GeneratePeriodsSheet;
