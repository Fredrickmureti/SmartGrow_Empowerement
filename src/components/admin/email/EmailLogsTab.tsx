// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Loader2, History, Mail, CheckCircle, XCircle, Clock, Eye } from "lucide-react";
import { format } from "date-fns";

interface EmailLog {
  id: string;
  recipient_email: string;
  recipient_name?: string | null;
  recipient_org_id?: string | null;
  subject: string | null;
  status: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  error_message: string | null;
  template_key: string | null;
  campaign_id: string | null;
  rule_id: string | null;
  resend_id: string | null;
  metadata?: any;
  created_at: string;
}

const statusConfig: Record<string, { icon: React.ReactNode; label: string; className: string }> = {
  pending: { icon: <Clock className="h-4 w-4" />, label: "Pending", className: "text-muted-foreground" },
  sent: { icon: <CheckCircle className="h-4 w-4" />, label: "Sent", className: "text-green-600" },
  opened: { icon: <Eye className="h-4 w-4" />, label: "Opened", className: "text-blue-600" },
  failed: { icon: <XCircle className="h-4 w-4" />, label: "Failed", className: "text-destructive" },
};

export function EmailLogsTab() {
  const { toast } = useToast();
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      const { data, error } = await supabase
        .from("platform_email_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      setLogs(data || []);
    } catch (error) {
      console.error("Error fetching logs:", error);
      toast({
        title: "Error",
        description: "Failed to load email logs",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-5 w-5" />
          Email Logs
        </CardTitle>
        <CardDescription>
          Recent email send history and delivery status
        </CardDescription>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Mail className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="font-medium">No emails sent yet</p>
            <p className="text-sm">Sent emails will appear here.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent At</TableHead>
                <TableHead>Opened At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const effectiveStatus = log.opened_at ? "opened" : log.status;
                const status = statusConfig[effectiveStatus] || statusConfig.pending;
                return (
                  <TableRow key={log.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{log.recipient_email}</p>
                        {log.template_key && (
                          <p className="text-xs text-muted-foreground">{log.template_key}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{log.subject}</TableCell>
                    <TableCell>
                      <div className={`flex items-center gap-2 ${status.className}`}>
                        {status.icon}
                        <span className="text-sm">{status.label}</span>
                      </div>
                      {log.error_message && (
                        <p className="text-xs text-destructive mt-1">{log.error_message}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {log.sent_at
                        ? format(new Date(log.sent_at), "MMM d, h:mm a")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {log.opened_at
                        ? format(new Date(log.opened_at), "MMM d, h:mm a")
                        : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
