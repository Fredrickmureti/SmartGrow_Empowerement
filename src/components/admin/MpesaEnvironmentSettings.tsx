// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Smartphone, Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";

export function MpesaEnvironmentSettings() {
  const { settings, isLoading, isSaving, getSetting, updateSetting } = usePlatformSettings();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingEnvironment, setPendingEnvironment] = useState<"sandbox" | "production" | null>(null);

  const currentEnvironment = getSetting("mpesa_environment") || "sandbox";
  const isProduction = currentEnvironment === "production";

  const handleToggle = (checked: boolean) => {
    const newEnvironment = checked ? "production" : "sandbox";
    
    if (newEnvironment === "production") {
      // Show confirmation dialog when switching to production
      setPendingEnvironment("production");
      setShowConfirmDialog(true);
    } else {
      // Switch to sandbox immediately
      updateSetting("mpesa_environment", "sandbox");
    }
  };

  const confirmSwitch = async () => {
    if (pendingEnvironment) {
      await updateSetting("mpesa_environment", pendingEnvironment);
    }
    setShowConfirmDialog(false);
    setPendingEnvironment(null);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className={isProduction ? "border-green-500/50" : "border-amber-500/50"}>
        <CardHeader className="p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2.5 sm:gap-3">
              <div className={`h-9 w-9 sm:h-10 sm:w-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                isProduction ? "bg-green-600" : "bg-amber-500"
              }`}>
                <Smartphone className="h-4 w-4 sm:h-5 sm:w-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-sm sm:text-base">M-Pesa Environment</CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  Global M-Pesa API environment for all organizations
                </CardDescription>
              </div>
            </div>
            <Badge 
              variant={isProduction ? "default" : "secondary"}
              className={`self-start sm:self-auto ${isProduction ? "bg-green-600" : "bg-amber-500 text-white"}`}
            >
              {isProduction ? "Production" : "Sandbox"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 pt-0 sm:pt-0">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="mpesa-env" className="text-sm sm:text-base font-medium">
                Production Mode
              </Label>
              <p className="text-xs sm:text-sm text-muted-foreground">
                {isProduction 
                  ? "All M-Pesa transactions use the live Safaricom API" 
                  : "All M-Pesa transactions use the sandbox API for testing"}
              </p>
            </div>
            <Switch
              id="mpesa-env"
              checked={isProduction}
              onCheckedChange={handleToggle}
              disabled={isSaving}
            />
          </div>

          {isProduction ? (
            <div className="p-3 sm:p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <div className="flex items-start gap-2.5 sm:gap-3">
                <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 text-green-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-sm font-medium text-green-700 dark:text-green-400">
                    Production Mode Active
                  </p>
                  <p className="text-xs sm:text-sm text-green-600 dark:text-green-500 mt-1">
                    All M-Pesa STK push transactions are real and will process actual money.
                    Organizations should use their live Daraja API credentials from Safaricom.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 sm:p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-start gap-2.5 sm:gap-3">
                <AlertTriangle className="h-4 w-4 sm:h-5 sm:w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs sm:text-sm font-medium text-amber-700 dark:text-amber-400">
                    Sandbox Mode Active
                  </p>
                  <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-500 mt-1">
                    All M-Pesa transactions are using the sandbox API. No real money will be processed.
                    Use sandbox credentials for testing. Switch to Production when ready to go live.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="pt-2 border-t text-xs sm:text-sm text-muted-foreground">
            <p>
              <strong>Note:</strong> This setting overrides all organization-level M-Pesa configurations.
              Users cannot see or change this setting - they only enter their credentials which work
              in whichever environment you select here.
            </p>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Switch to Production Mode?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                You are about to switch M-Pesa to <strong>Production Mode</strong>. This means:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>All STK push transactions will use the live Safaricom API</li>
                <li>Real money will be processed from customer M-Pesa accounts</li>
                <li>Organizations must use their live Daraja credentials</li>
              </ul>
              <p className="font-medium text-foreground">
                Are you sure you want to enable production mode?
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingEnvironment(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmSwitch}
              className="bg-green-600 hover:bg-green-700"
            >
              Yes, Enable Production
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
