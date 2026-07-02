/**
 * Device Manager Component
 * Displays and manages user's registered devices
 */

import { useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Smartphone,
  Monitor,
  Tablet,
  Globe,
  Shield,
  ShieldCheck,
  Trash2,
  MapPin,
  Clock,
  Fingerprint,
} from 'lucide-react';
import { useDeviceTracking, UserDevice } from '@/hooks/security/useDeviceTracking';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function DeviceManager() {
  const {
    devices,
    isLoadingDevices,
    trustDevice,
    isTrustingDevice,
    removeDevice,
    isRemovingDevice,
    currentDeviceInfo,
  } = useDeviceTracking();

  const [deviceToRemove, setDeviceToRemove] = useState<UserDevice | null>(null);

  const getDeviceIcon = (device: UserDevice) => {
    const type = device.device_type || 'unknown';
    switch (type) {
      case 'mobile':
        return <Smartphone className="h-5 w-5" />;
      case 'tablet':
        return <Tablet className="h-5 w-5" />;
      case 'desktop':
      default:
        return <Monitor className="h-5 w-5" />;
    }
  };

  const handleTrustToggle = (device: UserDevice, trusted: boolean) => {
    if (trusted) {
      trustDevice({ deviceId: device.id, trustDays: 30 });
    } else {
      // Untrust - just update the device
      // For now, we'll handle this by removing and re-adding
    }
  };

  const handleRemoveDevice = () => {
    if (deviceToRemove) {
      removeDevice(deviceToRemove.id);
      setDeviceToRemove(null);
    }
  };

  if (isLoadingDevices) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Your Devices
          </CardTitle>
          <CardDescription>Loading devices...</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-start gap-4 p-4 border rounded-lg">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            Your Devices
          </CardTitle>
          <CardDescription>
            Manage devices that have access to your account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devices && devices.length > 0 ? (
            devices.map((device) => (
              <div
                key={device.id}
                className={cn(
                  "flex items-start gap-4 p-4 border rounded-lg transition-colors",
                  device.is_current && "bg-primary/5 border-primary/20"
                )}
              >
                <div className={cn(
                  "flex items-center justify-center h-10 w-10 rounded-lg",
                  device.is_current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  {getDeviceIcon(device)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium truncate">
                      {device.device_name || `${device.browser} on ${device.os}`}
                    </h4>
                    {device.is_current && (
                      <Badge variant="default" className="shrink-0">
                        This device
                      </Badge>
                    )}
                    {device.is_trusted && (
                      <Badge variant="secondary" className="shrink-0">
                        <ShieldCheck className="h-3 w-3 mr-1" />
                        Trusted
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-muted-foreground">
                    {device.city && device.country && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {device.city}, {device.country}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDistanceToNow(new Date(device.last_seen_at), { addSuffix: true })}
                    </span>
                    <span className="flex items-center gap-1">
                      <Globe className="h-3 w-3" />
                      {device.ip_address || 'Unknown IP'}
                    </span>
                  </div>

                  <p className="text-xs text-muted-foreground mt-1">
                    First seen: {format(new Date(device.first_seen_at), 'MMM d, yyyy')}
                    {device.session_count > 1 && ` • ${device.session_count} sessions`}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!device.is_current && (
                    <>
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`trust-${device.id}`}
                          checked={device.is_trusted}
                          onCheckedChange={(checked) => handleTrustToggle(device, checked)}
                          disabled={isTrustingDevice}
                        />
                        <Label htmlFor={`trust-${device.id}`} className="text-sm cursor-pointer">
                          Trust
                        </Label>
                      </div>

                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeviceToRemove(device)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Fingerprint className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No devices registered yet</p>
              <p className="text-sm">Devices will appear here after you log in</p>
            </div>
          )}

          {currentDeviceInfo && (
            <div className="pt-4 border-t">
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Current Device Info
              </h4>
              <div className="text-xs text-muted-foreground space-y-1 bg-muted/50 p-3 rounded-lg">
                <p><span className="font-medium">Browser:</span> {currentDeviceInfo.browser} {currentDeviceInfo.browserVersion}</p>
                <p><span className="font-medium">OS:</span> {currentDeviceInfo.os} {currentDeviceInfo.osVersion}</p>
                <p><span className="font-medium">Device Type:</span> {currentDeviceInfo.deviceType}</p>
                <p className="truncate"><span className="font-medium">Fingerprint:</span> {currentDeviceInfo.fingerprint.slice(0, 16)}...</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!deviceToRemove} onOpenChange={() => setDeviceToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Device</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove "{deviceToRemove?.device_name || 'this device'}" from your account.
              Any saved PIN for this device will also be removed.
              The device will need to log in again with email and password.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveDevice}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemovingDevice ? 'Removing...' : 'Remove Device'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
