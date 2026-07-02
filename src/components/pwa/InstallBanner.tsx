/**
 * PWA Install Banner
 * 
 * A dismissible banner that prompts users to install the app.
 * Shows platform-specific instructions for iOS or install button for others.
 */

import { useState, useEffect } from 'react';
import { X, Download, Smartphone, Share2, Plus, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { motion, AnimatePresence } from 'framer-motion';

const BANNER_DISMISSED_KEY = 'pwa-install-banner-dismissed';
const BANNER_DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

interface InstallBannerProps {
  /** Variant of the banner */
  variant?: 'floating' | 'inline' | 'minimal';
  /** Called when the banner is dismissed */
  onDismiss?: () => void;
  /** Called when install is triggered */
  onInstall?: () => void;
}

export function InstallBanner({ 
  variant = 'floating',
  onDismiss,
  onInstall 
}: InstallBannerProps) {
  const { canInstall, isInstalled, promptInstall, platform, requiresManualInstall, installInstructions } = usePWAInstall();
  const [isVisible, setIsVisible] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  // Check if banner was recently dismissed
  useEffect(() => {
    const dismissedAt = localStorage.getItem(BANNER_DISMISSED_KEY);
    if (dismissedAt) {
      const dismissedTime = parseInt(dismissedAt, 10);
      if (Date.now() - dismissedTime < BANNER_DISMISS_DURATION) {
        return; // Still dismissed
      }
    }

    // Show banner after a delay if installable
    const timer = setTimeout(() => {
      if ((canInstall || requiresManualInstall) && !isInstalled) {
        setIsVisible(true);
      }
    }, 3000); // 3 second delay

    return () => clearTimeout(timer);
  }, [canInstall, isInstalled, requiresManualInstall]);

  const handleDismiss = () => {
    setIsVisible(false);
    localStorage.setItem(BANNER_DISMISSED_KEY, Date.now().toString());
    onDismiss?.();
  };

  const handleInstall = async () => {
    if (requiresManualInstall) {
      setShowInstructions(true);
    } else {
      const success = await promptInstall();
      if (success) {
        setIsVisible(false);
        onInstall?.();
      }
    }
  };

  if (!isVisible || isInstalled) {
    return null;
  }

  if (variant === 'minimal') {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50"
        >
          <Button
            onClick={handleInstall}
            className="gap-2 shadow-lg"
            size="sm"
          >
            <Download className="h-4 w-4" />
            Install App
          </Button>
        </motion.div>
      </AnimatePresence>
    );
  }

  if (variant === 'inline') {
    return (
      <div className="bg-primary/10 border border-primary/20 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/20">
            <Smartphone className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-foreground">Install AccrualFlow</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Add to your home screen for quick access and offline support.
            </p>
            {showInstructions && (
              <ol className="mt-3 space-y-2 text-sm">
                {installInstructions.map((instruction, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">
                      {index + 1}
                    </span>
                    <span>{instruction}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!showInstructions && (
              <Button onClick={handleInstall} size="sm">
                {requiresManualInstall ? 'How to Install' : 'Install'}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={handleDismiss}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Floating variant (default)
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 100 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 100 }}
        className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-50"
      >
        <div className="bg-background border border-border rounded-xl shadow-xl overflow-hidden">
          {/* Header */}
          <div className="p-4 bg-gradient-to-r from-primary/10 to-primary/5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary text-primary-foreground">
                  <Smartphone className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">Install AccrualFlow</h3>
                  <p className="text-xs text-muted-foreground">Add to home screen</p>
                </div>
              </div>
              <button
                onClick={handleDismiss}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="p-4">
            {!showInstructions ? (
              <>
                <p className="text-sm text-muted-foreground mb-4">
                  Get quick access, offline support, and a native app experience.
                </p>
                <div className="flex gap-2">
                  <Button onClick={handleInstall} className="flex-1 gap-2">
                    {requiresManualInstall ? (
                      <>
                        <Share2 className="h-4 w-4" />
                        Show Steps
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4" />
                        Install Now
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={handleDismiss}>
                    Later
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {platform === 'ios' ? 'Install on iOS:' : 'Follow these steps:'}
                </p>
                <ol className="space-y-3">
                  {installInstructions.map((instruction, index) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="flex items-start gap-3 text-sm"
                    >
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center font-medium">
                        {index + 1}
                      </span>
                      <span className="text-foreground pt-0.5">{instruction}</span>
                    </motion.li>
                  ))}
                </ol>
                <Button
                  variant="outline"
                  className="w-full mt-2"
                  onClick={handleDismiss}
                >
                  Got it!
                </Button>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

export default InstallBanner;
