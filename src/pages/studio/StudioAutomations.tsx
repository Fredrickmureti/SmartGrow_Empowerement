import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutomationBuilder } from "@/components/studio/AutomationBuilder";
import { AutomationExecutionLogs } from "@/components/studio/AutomationExecutionLogs";
import { Zap, History } from "lucide-react";

export default function StudioAutomations() {
  const [activeTab, setActiveTab] = useState("builder");

  return (
    <div className="container mx-auto py-4 sm:py-6 px-3 sm:px-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="builder" className="text-xs sm:text-sm">
            <Zap className="h-3.5 w-3.5 mr-1.5" />
            Automations
          </TabsTrigger>
          <TabsTrigger value="logs" className="text-xs sm:text-sm">
            <History className="h-3.5 w-3.5 mr-1.5" />
            Execution Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builder">
          <AutomationBuilder />
        </TabsContent>

        <TabsContent value="logs">
          <AutomationExecutionLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
