import { useState } from "react";
import { useDepreciationSchedule, DepreciationSchedule, AssetWithSchedule } from "@/hooks/useDepreciationSchedule";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Calendar,
  Calculator,
  CheckCircle,
  Clock,
  Loader2,
  RefreshCw,
  Play,
} from "lucide-react";
import { format, isAfter, isBefore, startOfMonth } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface DepreciationScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: AssetWithSchedule | null;
}

export function DepreciationScheduleDialog({
  open,
  onOpenChange,
  asset,
}: DepreciationScheduleDialogProps) {
  const { schedules, isLoading, generateSchedule, postDepreciation, pendingSchedules } =
    useDepreciationSchedule(asset?.id);
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [isGenerating, setIsGenerating] = useState(false);
  const [postingSchedule, setPostingSchedule] = useState<DepreciationSchedule | null>(null);
  const [isPosting, setIsPosting] = useState(false);

  const handleGenerate = async () => {
    if (!asset) return;
    setIsGenerating(true);
    try {
      await generateSchedule.mutateAsync(asset);
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePost = async () => {
    if (!asset || !postingSchedule) return;
    setIsPosting(true);
    try {
      await postDepreciation.mutateAsync({
        ...postingSchedule,
        asset,
      });
      setPostingSchedule(null);
    } finally {
      setIsPosting(false);
    }
  };

  const canPost = (schedule: DepreciationSchedule) => {
    if (schedule.is_posted) return false;
    const periodEnd = new Date(schedule.period_end);
    return isBefore(periodEnd, new Date());
  };

  const totalDepreciation = schedules.reduce((sum, s) => sum + s.depreciation_amount, 0);
  const postedTotal = schedules
    .filter((s) => s.is_posted)
    .reduce((sum, s) => sum + s.depreciation_amount, 0);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Depreciation Schedule</DialogTitle>
            <DialogDescription>
              {asset?.name} ({asset?.asset_number}) - {asset?.depreciation_method.replace("_", " ")} method
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-4 mb-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Purchase Price</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">
                  {formatCurrency(asset?.purchase_price || 0)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Residual Value</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">
                  {formatCurrency(asset?.residual_value || 0)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Total Depreciation</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{formatCurrency(totalDepreciation)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Posted to GL</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold text-green-600">
                  {formatCurrency(postedTotal)}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-between items-center mb-2">
            <div className="text-sm text-muted-foreground">
              {schedules.length} periods • {pendingSchedules.length} pending
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Regenerate Schedule
            </Button>
          </div>

          <div className="flex-1 overflow-auto border rounded-md">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : schedules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No schedule generated</h3>
                <p className="text-muted-foreground mb-4">
                  Generate a depreciation schedule for this asset.
                </p>
                <Button onClick={handleGenerate} disabled={isGenerating}>
                  {isGenerating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Calculator className="mr-2 h-4 w-4" />
                  )}
                  Generate Schedule
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Depreciation</TableHead>
                    <TableHead className="text-right">Accumulated</TableHead>
                    <TableHead className="text-right">Book Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((schedule) => (
                    <TableRow key={schedule.id}>
                      <TableCell>
                        {format(new Date(schedule.period_start), "MMM yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(schedule.depreciation_amount)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(schedule.accumulated_depreciation)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(schedule.book_value)}
                      </TableCell>
                      <TableCell>
                        {schedule.is_posted ? (
                          <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                            <CheckCircle className="mr-1 h-3 w-3" />
                            Posted
                          </Badge>
                        ) : canPost(schedule) ? (
                          <Badge variant="outline" className="text-orange-600">
                            <Clock className="mr-1 h-3 w-3" />
                            Ready
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            <Clock className="mr-1 h-3 w-3" />
                            Pending
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!schedule.is_posted && canPost(schedule) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPostingSchedule(schedule)}
                          >
                            <Play className="mr-1 h-3 w-3" />
                            Post
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!postingSchedule} onOpenChange={() => setPostingSchedule(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Post Depreciation to GL</AlertDialogTitle>
            <AlertDialogDescription>
              This will create a journal entry for{" "}
              {formatCurrency(postingSchedule?.depreciation_amount || 0)} depreciation expense for{" "}
              {postingSchedule && format(new Date(postingSchedule.period_start), "MMMM yyyy")}.
              <br />
              <br />
              <strong>Note:</strong> The asset category must have depreciation and accumulated
              depreciation accounts configured.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePost} disabled={isPosting}>
              {isPosting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Post to GL
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
