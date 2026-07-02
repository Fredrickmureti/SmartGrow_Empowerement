/**
 * CorrectionReviewPanel — manager reviews pending corrections.
 */
import { format } from "date-fns";
import { Check, X, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AttendanceRecord } from "@/hooks/useAttendance";

interface Props {
  corrections: AttendanceRecord[];
  onReview: (id: string, action: "approved" | "rejected") => void;
}

export function CorrectionReviewPanel({ corrections, onReview }: Props) {
  if (corrections.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Check className="h-12 w-12 text-emerald-500 mb-4" />
          <h3 className="text-lg font-medium">No Pending Corrections</h3>
          <p className="text-sm text-muted-foreground">
            All correction requests have been reviewed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {corrections.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="font-medium">
                  {r.employee
                    ? `${r.employee.first_name} ${r.employee.last_name}`
                    : "Unknown"}
                </p>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(r.attendance_date), "EEE, MMM d, yyyy")}
                </p>
                <div className="flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {r.original_clock_in
                      ? format(new Date(r.original_clock_in), "hh:mm a")
                      : "—"}{" "}
                    →{" "}
                    {r.clock_in
                      ? format(new Date(r.clock_in), "hh:mm a")
                      : "—"}
                  </span>
                  <span>
                    {r.original_clock_out
                      ? format(new Date(r.original_clock_out), "hh:mm a")
                      : "—"}{" "}
                    →{" "}
                    {r.clock_out
                      ? format(new Date(r.clock_out), "hh:mm a")
                      : "—"}
                  </span>
                </div>
                {r.correction_reason && (
                  <p className="text-sm italic text-muted-foreground">
                    "{r.correction_reason}"
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-emerald-600"
                  onClick={() => onReview(r.id, "approved")}
                >
                  <Check className="h-4 w-4 mr-1" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600"
                  onClick={() => onReview(r.id, "rejected")}
                >
                  <X className="h-4 w-4 mr-1" />
                  Reject
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
