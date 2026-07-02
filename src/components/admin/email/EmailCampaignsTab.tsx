// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Plus, Eye, Loader2, Megaphone, Clock, CheckCircle, Users } from "lucide-react";
import { format } from "date-fns";
import { NewCampaignDialog } from "./NewCampaignDialog";

interface Campaign {
  id: string;
  name: string;
  description: string | null;
  template_id: string | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  opened_count: number;
  created_at: string;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  draft: { label: "Draft", variant: "secondary" },
  scheduled: { label: "Scheduled", variant: "outline" },
  sending: { label: "Sending", variant: "default" },
  sent: { label: "Sent", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
};

export function EmailCampaignsTab() {
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showNewCampaignDialog, setShowNewCampaignDialog] = useState(false);

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    try {
      const { data, error } = await supabase
        .from("platform_email_campaigns")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setCampaigns(data || []);
    } catch (error) {
      console.error("Error fetching campaigns:", error);
      toast({
        title: "Error",
        description: "Failed to load campaigns",
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
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Megaphone className="h-5 w-5" />
                Email Campaigns
              </CardTitle>
              <CardDescription>
                Schedule and track email broadcasts to your users
              </CardDescription>
            </div>
            <Button onClick={() => setShowNewCampaignDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              New Campaign
            </Button>
          </div>
        </CardHeader>
        <CardContent>
        {campaigns.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Megaphone className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="font-medium">No campaigns yet</p>
            <p className="text-sm">Create your first email campaign to reach your users.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recipients</TableHead>
                <TableHead>Sent / Opened</TableHead>
                <TableHead>Scheduled / Sent At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((campaign) => {
                const status = statusConfig[campaign.status] || statusConfig.draft;
                return (
                  <TableRow key={campaign.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{campaign.name}</p>
                        <p className="text-xs text-muted-foreground">{campaign.description}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        {campaign.recipient_count}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-green-600">{campaign.sent_count}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-blue-600">{campaign.opened_count}</span>
                        {campaign.failed_count > 0 && (
                          <>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-red-600">{campaign.failed_count} failed</span>
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {campaign.sent_at ? (
                        <div className="flex items-center gap-1">
                          <CheckCircle className="h-4 w-4 text-green-600" />
                          {format(new Date(campaign.sent_at), "MMM d, h:mm a")}
                        </div>
                      ) : campaign.scheduled_at ? (
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          {format(new Date(campaign.scheduled_at), "MMM d, h:mm a")}
                        </div>
                      ) : (
                        "Not scheduled"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>

    <NewCampaignDialog
      open={showNewCampaignDialog}
      onOpenChange={setShowNewCampaignDialog}
      onSuccess={fetchCampaigns}
    />
  </>
  );
}
