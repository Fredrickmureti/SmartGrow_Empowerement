/**
 * PWA Install Page — one button, one action.
 */

import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Download, CheckCircle2, ArrowLeft, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePWAInstall, isRunningAsPWA } from '@/hooks/usePWAInstall';
import { toast } from 'sonner';

export default function Install() {
  const { isInstalled, promptInstall, hasNativePrompt, isPrompting, platform, installInstructions, requiresManualInstall } = usePWAInstall();
  const isStandalone = isRunningAsPWA();
  const [showInstructions, setShowInstructions] = useState(false);

  const handleInstall = async () => {
    if (!hasNativePrompt || requiresManualInstall) {
      setShowInstructions(true);
      return;
    }
    const ok = await promptInstall();
    if (ok) {
      toast.success('App installed.');
      return;
    }

    setShowInstructions(true);
    toast('The browser prompt was dismissed. Use the install steps below if you still want to add the app.');
  };

  if (isInstalled || isStandalone) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Already Installed</h1>
          <p className="text-muted-foreground mb-6">AccrualFlow is installed on this device.</p>
          <Button asChild>
            <Link to="/home">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Go to Dashboard
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center space-y-8">
        <div>
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-primary to-primary/80 text-primary-foreground mb-6 shadow-lg">
            <span className="text-3xl font-bold">A</span>
          </div>
          <h1 className="text-3xl font-bold mb-2">Install AccrualFlow</h1>
        </div>

        <Button
          onClick={handleInstall}
          disabled={isPrompting}
          size="lg"
          className="w-full h-14 text-lg gap-2"
        >
          {showInstructions || requiresManualInstall || !hasNativePrompt ? (
            <Share2 className="h-5 w-5" />
          ) : (
            <Download className="h-5 w-5" />
          )}
          {isPrompting ? 'Installing…' : showInstructions || requiresManualInstall || !hasNativePrompt ? 'Show install steps' : 'Install App'}
        </Button>

        {(showInstructions || requiresManualInstall || !hasNativePrompt) && (
          <div className="rounded-xl border border-border bg-muted/30 p-4 text-left space-y-3">
            <div>
              <p className="font-medium">Install steps for {platform === 'unknown' ? 'your browser' : platform}</p>
              <p className="text-sm text-muted-foreground">
                Some browsers do not expose the native install prompt. Use the menu option instead.
              </p>
            </div>
            <ol className="space-y-2 text-sm">
              {installInstructions.map((instruction, index) => (
                <li key={instruction} className="flex items-start gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                    {index + 1}
                  </span>
                  <span>{instruction}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <Link to="/home" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>
      </div>
    </div>
  );
}
