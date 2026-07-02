import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { Mail, FileText, Megaphone, Zap, BarChart3, History } from "lucide-react";
import { ComposeEmailTab } from "@/components/admin/email/ComposeEmailTab";
import { EmailTemplatesTab } from "@/components/admin/email/EmailTemplatesTab";
import { EmailCampaignsTab } from "@/components/admin/email/EmailCampaignsTab";
import { EmailAutomationsTab } from "@/components/admin/email/EmailAutomationsTab";
import { EmailAnalyticsTab } from "@/components/admin/email/EmailAnalyticsTab";
import { EmailLogsTab } from "@/components/admin/email/EmailLogsTab";

export default function AdminEmailCenter() {
  const { getSetting } = usePlatformSettings();
  const [activeTab, setActiveTab] = useState("compose");
  
  const emailConfigured = !!getSetting("resend_api_key");

  return (
    <>
      <div className="p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Email Center</h1>
          <p className="text-muted-foreground">
            Manage email communications, templates, campaigns, and automations
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-6 lg:w-auto lg:grid-cols-none lg:flex">
            <TabsTrigger value="compose" className="gap-2">
              <Mail className="h-4 w-4" />
              <span className="hidden sm:inline">Compose</span>
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              <FileText className="h-4 w-4" />
              <span className="hidden sm:inline">Templates</span>
            </TabsTrigger>
            <TabsTrigger value="campaigns" className="gap-2">
              <Megaphone className="h-4 w-4" />
              <span className="hidden sm:inline">Campaigns</span>
            </TabsTrigger>
            <TabsTrigger value="automations" className="gap-2">
              <Zap className="h-4 w-4" />
              <span className="hidden sm:inline">Automations</span>
            </TabsTrigger>
            <TabsTrigger value="analytics" className="gap-2">
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">Analytics</span>
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-2">
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">Logs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose">
            <ComposeEmailTab emailConfigured={emailConfigured} />
          </TabsContent>

          <TabsContent value="templates">
            <EmailTemplatesTab />
          </TabsContent>

          <TabsContent value="campaigns">
            <EmailCampaignsTab />
          </TabsContent>

          <TabsContent value="automations">
            <EmailAutomationsTab />
          </TabsContent>

          <TabsContent value="analytics">
            <EmailAnalyticsTab />
          </TabsContent>

          <TabsContent value="logs">
            <EmailLogsTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
