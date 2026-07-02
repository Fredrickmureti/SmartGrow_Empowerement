/**
 * PIN Settings Component
 * Manage user-level PIN login and inactivity timeout settings.
 * PIN is per-user (not per-device).
 */

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { usePINLogin } from '@/hooks/security/usePINLogin';
import { PINSetupDialog } from '@/components/auth/PINSetupDialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const TIMEOUT_OPTIONS = [
  { value: '1', label: '1 minute' },
  { value: '2', label: '2 minutes' },
  { value: '5', label: '5 minutes' },
  { value: '10', label: '10 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '0', label: 'Never' },
];

export function PINSettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    hasPin,
    pinEnabled,
    userPin,
    isCheckingPin,
    isLoadingPin,
    disablePin,
    isDisablingPin,
  } = usePINLogin();

  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  // Fetch inactivity timeout preference
  const { data: securityPrefs } = useQuery({
    queryKey: ['user-security-preferences', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await (supabase as any)
        .from('user_security_preferences')
        .select('inactivity_timeout_minutes')
        .eq('user_id', user.id)
        .maybeSingle();
      return data as { inactivity_timeout_minutes: number | null } | null;
    },
    enabled: !!user,
  });

  const currentTimeout = securityPrefs?.inactivity_timeout_minutes ?? 5;

  const handleTimeoutChange = async (value: string) => {
    if (!user) return;
    const minutes = parseInt(value);
    const timeoutValue = minutes === 0 ? null : minutes;

    const { error } = await (supabase as any)
      .from('user_security_preferences')
      .upsert({
        user_id: user.id,
        inactivity_timeout_minutes: timeoutValue,
      }, { onConflict: 'user_id' });

    if (error) {
      toast({ title: 'Error', description: 'Failed to update timeout setting', variant: 'destructive' });
    } else {
      queryClient.invalidateQueries({ queryKey: ['user-security-preferences'] });
      queryClient.invalidateQueries({ queryKey: ['user-security-preferences-timeout'] });
      toast({ title: 'Updated', description: `Inactivity timeout set to ${minutes === 0 ? 'never' : `${minutes} minutes`}` });
    }
  };

  const handleDisablePin = () => {
    disablePin();
    setShowDisableConfirm(false);
  };

  if (isCheckingPin || isLoadingPin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Quick Login PIN
          </CardTitle>
          <CardDescription>Loading PIN settings...</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Quick Login PIN
          </CardTitle>
          <CardDescription>
            Use a PIN for faster sign-in instead of your password
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* PIN Status */}
          <div className={cn(
            "p-4 rounded-lg border",
            hasPin && pinEnabled ? "bg-primary/5 border-primary/20" : "bg-muted/50"
          )}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className={cn(
                  "flex items-center justify-center h-10 w-10 rounded-full",
                  hasPin && pinEnabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  {hasPin && pinEnabled ? <ShieldCheck className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
                </div>
                <div>
                  <h4 className="font-medium">PIN Login</h4>
                  <p className="text-sm text-muted-foreground">
                    {hasPin && pinEnabled
                      ? `${userPin?.pin_length}-digit PIN is active`
                      : 'No PIN configured'}
                  </p>
                  {userPin?.last_used_at && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Last used: {formatDistanceToNow(new Date(userPin.last_used_at), { addSuffix: true })}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                {hasPin && pinEnabled ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSetupDialog(true)}
                    >
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setShowDisableConfirm(true)}
                    >
                      Disable
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setShowSetupDialog(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Set Up PIN
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Inactivity Timeout */}
          <div className="p-4 rounded-lg border space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center h-10 w-10 rounded-full bg-primary/10 text-primary">
                <Timer className="h-5 w-5" />
              </div>
              <div className="flex-1 space-y-2">
                <div>
                  <h4 className="font-medium">Inactivity Timeout</h4>
                  <p className="text-sm text-muted-foreground">
                    Automatically sign out after a period of inactivity. You'll need to sign in again with your password or PIN.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Label htmlFor="timeout-select" className="text-sm whitespace-nowrap">Sign out after</Label>
                  <Select
                    value={String(currentTimeout === null ? 0 : currentTimeout)}
                    onValueChange={handleTimeoutChange}
                  >
                    <SelectTrigger id="timeout-select" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEOUT_OPTIONS.map(opt => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </div>

          {/* Security Tips */}
          <div className="p-4 bg-muted/50 rounded-lg space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Security Tips
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Your PIN works across all your devices</li>
              <li>Use a PIN you can remember but others can't guess</li>
              <li>Avoid patterns like 1234 or repeated digits</li>
              <li>After 5 failed attempts, PIN login is temporarily locked</li>
              <li>Set an inactivity timeout for automatic sign-out when you step away</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* PIN Setup Dialog */}
      <PINSetupDialog
        open={showSetupDialog}
        onOpenChange={setShowSetupDialog}
      />

      {/* Disable PIN Confirmation */}
      <AlertDialog open={showDisableConfirm} onOpenChange={setShowDisableConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable PIN Login</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove your PIN. You'll need to use your email and password to sign in. You can set up a new PIN anytime from settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisablePin}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDisablingPin ? 'Disabling...' : 'Disable PIN'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
