import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NotificationSettings } from "./NotificationSettings";
import { NotificationDiagnostics } from "./NotificationDiagnostics";
import { useSession } from "@/contexts/SessionContext";
import { Bell, Activity } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useCallback } from "react";

const VALID_SUBTABS = ["preferences", "diagnostics"] as const;
type SubTab = (typeof VALID_SUBTABS)[number];

export function EnhancedNotificationSettings() {
  const { userType } = useSession();
  const isPortalUser = userType === "portal";
  const [searchParams, setSearchParams] = useSearchParams();

  // Portal users only see notification preferences (filtered to relevant categories)
  // They see the same preference matrix, filtered to relevant categories.
  if (isPortalUser) {
    return (
      <div className="space-y-6">
        <NotificationSettings />
      </div>
    );
  }

  const raw = searchParams.get("ntab");
  const subtab: SubTab = (VALID_SUBTABS as readonly string[]).includes(raw ?? "")
    ? (raw as SubTab)
    : "preferences";

  const handleSubtabChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value === "preferences") {
        next.delete("ntab");
      } else {
        next.set("ntab", value);
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="space-y-6">
      <Tabs value={subtab} onValueChange={handleSubtabChange} className="space-y-4">
        <TabsList>
          <TabsTrigger value="preferences" className="gap-2">
            <Bell className="h-4 w-4" />
            Preferences
          </TabsTrigger>
          <TabsTrigger value="diagnostics" className="gap-2">
            <Activity className="h-4 w-4" />
            Diagnostics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="preferences">
          <NotificationSettings />
        </TabsContent>

        <TabsContent value="diagnostics">
          <NotificationDiagnostics />
        </TabsContent>
      </Tabs>
    </div>
  );
}
