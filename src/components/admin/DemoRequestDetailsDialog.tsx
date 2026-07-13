// @ts-nocheck - Admin tables not in auto-generated types
/**
 * DemoRequestPeekSheet — read-mostly peek for the Demo Requests list.
 * Replaces the legacy DemoRequestDetailsDialog per
 * docs/design-system/audit/platform-admin.md.
 * The old export name is kept as an alias so existing imports keep working.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DocumentPeekShell } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import {
  Mail,
  Phone,
  Building2,
  Calendar,
  Clock,
  CheckCircle,
  XCircle,
  MessageSquare,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface DemoRequest {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
  phone: string | null;
  message: string | null;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  contacted_at: string | null;
  contacted_by: string | null;
}

interface DemoRequestDetailsDialogProps {
  request: DemoRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (status: string) => void;
  /** When provided, the "Send Email" button opens the in-app composer instead of mailto:. */
  onComposeEmail?: () => void;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "secondary" },
  contacted: { label: "Contacted", variant: "default" },
  completed: { label: "Completed", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "destructive" },
};

export function DemoRequestDetailsDialog({
  request,
  open,
  onOpenChange,
  onStatusChange,
  onComposeEmail,
}: DemoRequestDetailsDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adminNotes, setAdminNotes] = useState(request.admin_notes || "");
  const [isSaving, setIsSaving] = useState(false);

  const saveNotesMutation = useMutation({
    mutationFn: async (notes: string) => {
      const { error } = await (supabase.from as any)("demo_requests")
        .update({ admin_notes: notes })
        .eq("id", request.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["demo-requests"] });
      toast({ title: "Notes saved" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to save notes",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const handleSaveNotes = async () => {
    setIsSaving(true);
    await saveNotesMutation.mutateAsync(adminNotes);
    setIsSaving(false);
  };

  const status = statusConfig[request.status] || statusConfig.pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl">{request.full_name}</DialogTitle>
              <DialogDescription>Demo request details</DialogDescription>
            </div>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
        </DialogHeader>

        <div className="space-y-6">
          {/* Contact Information */}
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-muted-foreground">Contact Information</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Email</p>
                  <a
                    href={`mailto:${request.email}`}
                    className="text-sm text-primary hover:underline truncate block"
                  >
                    {request.email}
                  </a>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0"
                  onClick={() => {
                    if (onComposeEmail) {
                      onComposeEmail();
                      onOpenChange(false);
                    } else {
                      window.open(`mailto:${request.email}?subject=Re: Your AccrualFlow Demo Request`);
                    }
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>

              {request.phone && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Phone</p>
                    <a
                      href={`tel:${request.phone}`}
                      className="text-sm text-primary hover:underline"
                    >
                      {request.phone}
                    </a>
                  </div>
                </div>
              )}

              {request.company_name && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Company</p>
                    <p className="text-sm">{request.company_name}</p>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Submitted</p>
                  <p className="text-sm">
                    {format(new Date(request.created_at), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Message */}
          {request.message && (
            <div className="space-y-2">
              <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-1">
                <MessageSquare className="h-4 w-4" />
                Message from Requester
              </h4>
              <div className="p-4 rounded-lg bg-muted/50 text-sm whitespace-pre-wrap">
                {request.message}
              </div>
            </div>
          )}

          <Separator />

          {/* Admin Notes */}
          <div className="space-y-2">
            <Label htmlFor="admin-notes">Admin Notes</Label>
            <Textarea
              id="admin-notes"
              placeholder="Add internal notes about this request..."
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={handleSaveNotes}
                disabled={isSaving || adminNotes === request.admin_notes}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Notes"
                )}
              </Button>
            </div>
          </div>

          <Separator />

          {/* Actions */}
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-muted-foreground">Quick Actions</h4>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (onComposeEmail) {
                    onComposeEmail();
                    onOpenChange(false);
                  } else {
                    window.open(`mailto:${request.email}?subject=Re: Your AccrualFlow Demo Request`);
                  }
                }}
              >
                <Mail className="h-4 w-4 mr-2" />
                Send Email
              </Button>
              
              {request.status !== "contacted" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onStatusChange("contacted");
                    onOpenChange(false);
                  }}
                >
                  <Clock className="h-4 w-4 mr-2" />
                  Mark as Contacted
                </Button>
              )}
              
              {request.status !== "completed" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onStatusChange("completed");
                    onOpenChange(false);
                  }}
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Mark as Completed
                </Button>
              )}
              
              {request.status !== "cancelled" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    onStatusChange("cancelled");
                    onOpenChange(false);
                  }}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
