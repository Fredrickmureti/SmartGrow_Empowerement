/**
 * AttendanceReviewCard — lists attendance rows the risk engine flagged as
 * requiring manager review (impossible travel, untrusted device, geofence
 * miss). Acknowledging a row clears the flag via `attendance_anomaly_ack`.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ShieldAlert, Loader2, Check } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useAttendanceReviewQueue } from "@/hooks/hr/useAttendanceReviewQueue";

export function AttendanceReviewCard() {
  const { data: rows = [], isLoading } = useAttendanceReviewQueue();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const ack = useMutation({
    mutationFn: async ({ id, codes }: { id: string; codes: string[] }) => {
      const { error } = await supabase.rpc("attendance_anomaly_ack" as any, {
        _attendance_id: id,
        _codes: codes,
      });
      if (error) throw error;
    },
    onMutate: ({ id }) => setBusyId(id),
    onSuccess: () => {
      toast.success("Acknowledged — removed from review queue");
      qc.invalidateQueries({ queryKey: ["attendance-review-queue"] });
      qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to acknowledge"),
    onSettled: () => setBusyId(null),
  });

  if (!isLoading && rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          Attendance review queue
        </CardTitle>
        <Badge variant="secondary">{rows.length} flagged</Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead className="w-[120px] text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.employee
                      ? `${r.employee.first_name} ${r.employee.last_name}`
                      : r.employee_id.slice(0, 8)}
                    {r.employee?.employee_number && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({r.employee.employee_number})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.clock_in
                      ? formatDistanceToNow(new Date(r.clock_in), {
                          addSuffix: true,
                        })
                      : r.attendance_date}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(r.review_reasons ?? []).map((code) => (
                        <Badge
                          key={code}
                          variant="outline"
                          className="text-[10px]"
                        >
                          {code}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.id}
                      onClick={() =>
                        ack.mutate({ id: r.id, codes: r.review_reasons ?? [] })
                      }
                    >
                      {busyId === r.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3 mr-1" />
                      )}
                      Acknowledge
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
