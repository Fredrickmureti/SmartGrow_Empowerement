import { ReactNode, useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WifiOff, RefreshCw, Cloud } from "lucide-react";


interface OnlineOnlyRouteProps {
  children: ReactNode;
  moduleName: string;
}

/**
 * Wrapper component for ERP modules that require online connectivity
 * In Electron app, these modules won't work offline - only POS has offline capability
 */
export function OnlineOnlyRoute({ children, moduleName }: OnlineOnlyRouteProps) {
  const [isOnline, setIsOnline] = useState(true);
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    // Check if running in Electron via the capability-scoped window.pos bridge.
    const pos = window.pos;
    setIsElectron(!!pos?.isElectron);

    if (pos?.isElectron) {
      // Use Electron's network status
      const checkStatus = async () => {
        const online = await pos.network.getStatus();
        setIsOnline(online);
      };

      checkStatus();

      // Listen for network status changes
      pos.network.onStatusChange((online: boolean) => {
        setIsOnline(online);
      });

      return () => {
        pos.network.removeAllListeners();
      };
    } else {
      // Browser - use navigator.onLine
      setIsOnline(navigator.onLine);

      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);

      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }
  }, []);

  // If online or not in Electron, render children normally
  if (isOnline || !isElectron) {
    return <>{children}</>;
  }

  // Offline in Electron - show offline message
  return (
    <>
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <WifiOff className="h-8 w-8 text-muted-foreground" />
            </div>
            
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">No Internet Connection</h2>
              <p className="text-muted-foreground">
                {moduleName} requires an internet connection. This feature is not available in offline mode.
              </p>
            </div>

            <div className="bg-muted/50 rounded-lg p-4 text-sm text-left space-y-2">
              <div className="flex items-start gap-2">
                <Cloud className="h-4 w-4 mt-0.5 text-primary" />
                <div>
                  <p className="font-medium">Online-Only Feature</p>
                  <p className="text-muted-foreground text-xs">
                    ERP modules like CRM, Projects, Timesheets, and Leave Management require real-time data synchronization.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Button 
                onClick={() => window.location.reload()}
                className="w-full"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry Connection
              </Button>
              <Button 
                variant="outline"
                onClick={() => window.location.href = "/pos"}
                className="w-full"
              >
                Go to POS (Works Offline)
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
