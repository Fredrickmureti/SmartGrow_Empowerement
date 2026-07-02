import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getHardwareCapabilities, isElectron } from "@/lib/environment";
import { 
  Wifi, 
  WifiOff, 
  Monitor, 
  Smartphone,
  Laptop,
  Server
} from "lucide-react";

export function OfflineSettingsCard() {
  const capabilities = getHardwareCapabilities();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isElectron() ? <Laptop className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
            Offline Mode Status
          </CardTitle>
          <CardDescription>
            POS continues to work when internet connection is lost
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 border rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Wifi className="h-5 w-5 text-green-500" />
                <span className="font-medium">Online Mode</span>
              </div>
              <p className="text-sm text-muted-foreground">
                All transactions sync in real-time with the server. Full feature access.
              </p>
            </div>
            <div className="p-4 border rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <WifiOff className="h-5 w-5 text-orange-500" />
                <span className="font-medium">Offline Mode</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Transactions stored locally using IndexedDB. Auto-syncs when back online.
              </p>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-lg">
            <h4 className="font-medium mb-3">Offline Capabilities</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Process Sales</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Cash Payments</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Print Receipts</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Hold Transactions</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Product Cache</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">○</Badge>
                <span className="text-sm text-muted-foreground">Card Payments*</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              *Card payments require online connection for authorization
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Sync Queue
          </CardTitle>
          <CardDescription>Pending transactions waiting to sync</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Wifi className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No pending transactions</p>
            <p className="text-sm">All data is synchronized</p>
          </div>
        </CardContent>
      </Card>

      {isElectron() && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Laptop className="h-5 w-5" />
              Desktop App Features
            </CardTitle>
            <CardDescription>Additional features in Electron mode</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Native USB Printing</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Serial Scale Support</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Kiosk Mode</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="default">✓</Badge>
                <span className="text-sm">Auto Updates</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
