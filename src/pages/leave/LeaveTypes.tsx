/**
 * LeaveTypes — standalone admin page for leave types.
 *
 * Promoted out of the in-LeaveDashboard settings dialog so each Time-off admin
 * surface is deep-linkable (/hr/leave/types). The page hosts the existing
 * LeaveTypeSettingsDialog kept open by default — closing it returns to the
 * Time-off overview.
 */
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil, Plus, Loader2, Lock } from "lucide-react";
import { useLeaveTypes } from "@/hooks/leave";
import { usePermissions } from "@/hooks/usePermissions";
import { LeaveTypeSettingsDialog } from "@/components/leave/LeaveTypeSettingsDialog";

export default function LeaveTypes() {
  const { can } = usePermissions();
  const { leaveTypes, isLoading } = useLeaveTypes();
  const [dialogOpen, setDialogOpen] = useState(false);
  const navigate = useNavigate();

  if (!can("manageLeaveTypes")) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mb-3" />
          <h3 className="font-semibold">Manage-leave-types permission required</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Ask your HR administrator to grant you the "Manage leave types" permission.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Leave Types</h1>
          <p className="text-sm text-muted-foreground">
            Define the leave types employees can request and how each is governed.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Add / Edit leave types
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured leave types</CardTitle>
          <CardDescription>
            Each type controls eligibility, approval flow, and accrual.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : leaveTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No leave types yet. Click "Add / Edit leave types" to create your first.
            </p>
          ) : (
            <ul className="divide-y">
              {leaveTypes.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: t.color }}
                    />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{t.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {t.is_paid ? "Paid" : "Unpaid"} ·{" "}
                        {t.requires_approval ? "Needs approval" : "Auto-approved"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline">{t.code}</Badge>
                    <Button variant="ghost" size="sm" onClick={() => setDialogOpen(true)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">
        <button
          className="underline hover:text-foreground"
          onClick={() => navigate("/hr/leave")}
        >
          ← Back to Time off
        </button>
      </div>

      <LeaveTypeSettingsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
