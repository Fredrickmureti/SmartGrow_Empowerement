/**
 * PWA Install Hook
 * 
 * Manages the PWA installation prompt and provides utilities for:
 * - Detecting if app is installable
 * - Triggering the install prompt
 * - Detecting if running as installed PWA
 * - Platform-specific install instructions
 */

import { useState, useEffect, useCallback } from 'react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

type Platform = 'ios' | 'android' | 'windows' | 'macos' | 'unknown';

interface UsePWAInstallResult {
  /** Whether the app can be installed (browser supports it and not already installed) */
  canInstall: boolean;
  /** Whether the app is currently running as an installed PWA */
  isInstalled: boolean;
  /** Whether the install prompt is currently showing */
  isPrompting: boolean;
  /** Trigger the install prompt */
  promptInstall: () => Promise<boolean>;
  /** The detected platform */
  platform: Platform;
  /** Whether the platform requires manual installation (iOS) */
  requiresManualInstall: boolean;
  /** Platform-specific installation instructions */
  installInstructions: string[];
  /** True if a native deferred prompt is currently available */
  hasNativePrompt: boolean;
  /** True whenever an install entry point should be visible (not installed AND some install path exists) */
  canShowInstallUI: boolean;
}

export function usePWAInstall(): UsePWAInstallResult {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isPrompting, setIsPrompting] = useState(false);

  // Detect platform
  const platform = detectPlatform();
  const requiresManualInstall = platform === 'ios';

  // Check if running as installed PWA
  useEffect(() => {
    const checkInstalled = () => {
      // Check display-mode media query
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
      // Check iOS standalone mode
      const isIOSStandalone = (navigator as any).standalone === true;
      // Check if launched from home screen (has no referrer and specific display mode)
      const hasNoReferrer = document.referrer === '';
      
      setIsInstalled(isStandalone || isIOSStandalone);
    };

    checkInstalled();

    // Listen for display mode changes
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const handleChange = (e: MediaQueryListEvent) => setIsInstalled(e.matches);
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Listen for beforeinstallprompt event
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  // Trigger install prompt
  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) {
      console.warn('Install prompt not available');
      return false;
    }

    setIsPrompting(true);

    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      // Per spec the BeforeInstallPromptEvent is single-use once prompt()
      // resolves — clear it regardless of outcome so UI falls back to the
      // manual /install page on the next click instead of silently no-op'ing.
      setDeferredPrompt(null);
      return outcome === 'accepted';
    } catch (error) {
      console.error('Error prompting install:', error);
      setDeferredPrompt(null);
      return false;
    } finally {
      setIsPrompting(false);
    }
  }, [deferredPrompt]);

  // Get platform-specific instructions
  const installInstructions = getInstallInstructions(platform);

  const hasNativePrompt = !!deferredPrompt;
  // Surface an install entry point whenever the app is not yet installed.
  // Even if the browser never fires beforeinstallprompt (already dismissed,
  // throttled, iOS Safari, or first visit), we can route the user to the
  // /install page which carries platform-specific manual instructions and
  // a QR for cross-device installs.
  const canShowInstallUI = !isInstalled;

  return {
    canInstall: hasNativePrompt && !isInstalled,
    isInstalled,
    isPrompting,
    promptInstall,
    platform,
    requiresManualInstall,
    installInstructions,
    hasNativePrompt,
    canShowInstallUI,
  };
}

function detectPlatform(): Platform {
  const userAgent = navigator.userAgent.toLowerCase();
  
  if (/iphone|ipad|ipod/.test(userAgent)) {
    return 'ios';
  }
  if (/android/.test(userAgent)) {
    return 'android';
  }
  if (/windows/.test(userAgent)) {
    return 'windows';
  }
  if (/macintosh|mac os x/.test(userAgent)) {
    return 'macos';
  }
  return 'unknown';
}

function getInstallInstructions(platform: Platform): string[] {
  switch (platform) {
    case 'ios':
      return [
        'Tap the Share button in Safari',
        'Scroll down and tap "Add to Home Screen"',
        'Tap "Add" to install AccrualFlow'
      ];
    case 'android':
      return [
        'Tap the menu button (⋮) in Chrome',
        'Tap "Add to Home screen" or "Install app"',
        'Tap "Install" to add AccrualFlow'
      ];
    case 'windows':
    case 'macos':
      return [
        'Click the install icon in the address bar',
        'Or click the menu (⋮) and select "Install AccrualFlow"',
        'Click "Install" in the popup'
      ];
    default:
      return [
        'Look for an install option in your browser menu',
        'This may be called "Install", "Add to Home Screen", or similar'
      ];
  }
}

/**
 * Check if the app is running in standalone mode (as PWA)
 */
export function isRunningAsPWA(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as any).standalone === true
  );
}

/**
 * Get the app's current display mode
 */
export function getDisplayMode(): 'standalone' | 'browser' | 'minimal-ui' | 'fullscreen' {
  if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui';
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
  return 'browser';
}
