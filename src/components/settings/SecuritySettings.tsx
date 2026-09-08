/**
 * Security Settings Component
 * Combines PIN settings, device management, and login activity
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PINSettings } from '@/components/settings/PINSettings';
import { ChangePasswordCard } from '@/components/settings/ChangePasswordCard';
import { DeviceManager } from '@/components/settings/DeviceManager';
import { LoginActivityCard } from '@/components/settings/LoginActivityCard';
import { useDeviceTracking } from '@/hooks/security/useDeviceTracking';
import { Badge } from '@/components/ui/badge';
import { Lock, Monitor, History, Bell, Shield } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';

export function SecuritySettings() {
  const { alerts, unreadAlertCount, markAlertRead } = useDeviceTracking();

  return (
    <div className="space-y-6">
      {/* Security Overview Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Account Security
          </CardTitle>
          <CardDescription>
            Manage your login methods, devices, and security preferences
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">Quick Login</p>
                <p className="text-xs text-muted-foreground">PIN-based access</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Monitor className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">Device Tracking</p>
                <p className="text-xs text-muted-foreground">Monitor access</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Bell className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">Security Alerts</p>
                <p className="text-xs text-muted-foreground">
                  {unreadAlertCount > 0 ? `${unreadAlertCount} unread` : 'All clear'}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Unread Alerts */}
      {alerts && alerts.length > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4" />
              Security Alerts
              <Badge variant="secondary">{alerts.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {alerts.slice(0, 5).map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-start justify-between gap-3 p-3 bg-background rounded-lg border"
                  >
                    <div className="flex-1">
                      <p className="font-medium text-sm">{alert.title}</p>
                      <p className="text-xs text-muted-foreground">{alert.message}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(alert.created_at), { addSuffix: true })}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => markAlertRead(alert.id)}
                    >
                      Dismiss
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Security Tabs */}
      <Tabs defaultValue="pin" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="pin" className="gap-2">
            <Lock className="h-4 w-4" />
            <span className="hidden sm:inline">Quick Login PIN</span>
            <span className="sm:hidden">PIN</span>
          </TabsTrigger>
          <TabsTrigger value="devices" className="gap-2">
            <Monitor className="h-4 w-4" />
            <span className="hidden sm:inline">Your Devices</span>
            <span className="sm:hidden">Devices</span>
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-2">
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Login Activity</span>
            <span className="sm:hidden">Activity</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pin">
          <PINSettings />
        </TabsContent>

        <TabsContent value="devices">
          <DeviceManager />
        </TabsContent>

        <TabsContent value="activity">
          <LoginActivityCard limit={25} showViewAll={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
