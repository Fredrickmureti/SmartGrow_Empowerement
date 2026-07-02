/**
 * Sentry Error Tracking Configuration
 * 
 * Supports both build-time (VITE_SENTRY_DSN) and runtime (database) configuration.
 * Dynamic configuration allows platform admins to enable/disable error tracking
 * from the admin settings without code changes.
 */

import * as SentryNS from "@sentry/react";
// SDK v8 export typings drift between subpath builds; behavior is correct, only types are off.
const Sentry: any = SentryNS;

// Track initialization state
let sentryInitialized = false;
let currentDsn: string | null = null;

// Fallback to env variable if set at build time
const ENV_SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || "";

// Determine environment from URL
const getEnvironment = (): string => {
  const hostname = window.location.hostname;
  if (hostname.includes("localhost") || hostname.includes("127.0.0.1")) {
    return "development";
  }
  if (hostname.includes("preview") || hostname.includes("id-preview")) {
    return "preview";
  }
  return "production";
};

// Filter out noisy errors that don't need tracking
const shouldIgnoreError = (error: Error | string): boolean => {
  const errorMessage = typeof error === "string" ? error : error.message;
  
  const ignoredPatterns = [
    // Transient network issues (page unload, user navigation)
    "Load failed",
    "AbortError",
    "The operation was aborted",
    // Browser extension interference
    "ResizeObserver loop",
    "Non-Error promise rejection",
    // Third-party script errors
    "Script error.",
    // Auth-related (handled gracefully in app)
    "JWT expired",
    "Invalid Refresh Token",
    "Refresh Token Not Found",
    // React hydration warnings (expected in some cases)
    "Hydration failed",
  ];
  
  return ignoredPatterns.some(pattern => 
    errorMessage?.toLowerCase().includes(pattern.toLowerCase())
  );
};

interface SentryInitOptions {
  dsn: string;
  environment?: string;
  sampleRate?: number;
}

/**
 * Initialize Sentry with the provided configuration
 */
const initializeSentryInternal = (options: SentryInitOptions): void => {
  const { dsn, environment, sampleRate = 0.1 } = options;
  const env = environment || getEnvironment();
  
  // Skip in development unless DSN is explicitly set
  if (env === "development" && !dsn) {
    console.log("[Sentry] Skipping initialization in development");
    return;
  }
  
  if (!dsn) {
    console.warn("[Sentry] No DSN configured, error tracking disabled");
    return;
  }
  
  Sentry.init({
    dsn,
    environment: env,
    
    // Sample rates
    tracesSampleRate: env === "production" ? sampleRate : 0.5,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: env === "production" ? 1.0 : 0,
    
    // Filter errors before sending
    beforeSend(event, hint) {
      const error = hint.originalException;
      
      if (error && shouldIgnoreError(error as Error)) {
        return null;
      }
      
      // Strip potential PII from breadcrumbs
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map(crumb => {
          if (crumb.category === "fetch" && crumb.data?.url) {
            // Remove auth tokens from URLs
            crumb.data.url = crumb.data.url.replace(/apikey=[^&]+/, "apikey=[REDACTED]");
          }
          return crumb;
        });
      }
      
      return event;
    },
    
    // Integration options
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    
    // Ignore specific errors
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      /^Script error\.?$/,
      /^Non-Error promise rejection captured/,
    ],
    
    // Deny list for URLs (third-party scripts)
    denyUrls: [
      /extensions\//i,
      /^chrome:\/\//i,
      /^moz-extension:\/\//i,
    ],
  });
  
  sentryInitialized = true;
  currentDsn = dsn;
  console.log(`[Sentry] Initialized for ${env}`);
};

/**
 * Initialize Sentry using build-time env variable
 * Call this early in main.tsx for immediate error capture
 */
export const initSentry = (): void => {
  if (ENV_SENTRY_DSN) {
    initializeSentryInternal({ dsn: ENV_SENTRY_DSN });
  } else {
    console.log("[Sentry] No build-time DSN, waiting for database configuration");
  }
};

/**
 * Reinitialize Sentry with new configuration (from database)
 * Called when admin saves new Sentry settings
 */
export const reinitializeSentry = (options: SentryInitOptions): void => {
  // If already initialized with same DSN, skip
  if (sentryInitialized && currentDsn === options.dsn) {
    console.log("[Sentry] Already initialized with same DSN");
    return;
  }
  
  // Close existing client if any
  if (sentryInitialized) {
    Sentry.close(2000).then(() => {
      initializeSentryInternal(options);
    });
  } else {
    initializeSentryInternal(options);
  }
};

/**
 * Disable Sentry error tracking
 */
export const disableSentry = (): void => {
  if (sentryInitialized) {
    Sentry.close(2000);
    sentryInitialized = false;
    currentDsn = null;
    console.log("[Sentry] Disabled");
  }
};

/**
 * Check if Sentry is currently initialized
 */
export const isSentryInitialized = (): boolean => sentryInitialized;

/**
 * Test Sentry DSN validity
 */
export const testSentryConnection = async (dsn: string): Promise<{ success: boolean; error?: string }> => {
  try {
    // Validate DSN format - support regional endpoints (us, de, etc.) and self-hosted
    // Format: https://{PUBLIC_KEY}@{HOST}/{PROJECT_ID}
    // Examples:
    //   https://abc123@o12345.ingest.sentry.io/67890         (legacy)
    //   https://abc123@o12345.ingest.us.sentry.io/67890      (US region)
    //   https://abc123@o12345.ingest.de.sentry.io/67890      (EU region)
    //   https://abc123@sentry.mycompany.com/67890            (self-hosted)
    
    const dsnPattern = /^https:\/\/[a-f0-9]+@[a-z0-9.-]+\/\d+$/i;
    
    if (!dsnPattern.test(dsn)) {
      return { success: false, error: "Invalid DSN format. Expected: https://{key}@{host}/{project_id}" };
    }
    
    // Parse DSN to extract components
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace("/", "");
    
    // Validate we have required components
    if (!publicKey || publicKey.length < 16) {
      return { success: false, error: "Invalid public key in DSN" };
    }
    
    if (!projectId || !/^\d+$/.test(projectId)) {
      return { success: false, error: "Invalid project ID in DSN" };
    }
    
    // Make a lightweight API call to validate
    const storeEndpoint = `https://${url.host}/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`;
    
    const response = await fetch(storeEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
      },
      body: `{"sent_at":"${new Date().toISOString()}"}\n{"type":"check_in"}\n{}`,
    });
    
    // Sentry returns 200 for valid DSN, 401/403 for invalid
    if (response.ok || response.status === 200) {
      return { success: true };
    }
    
    return { success: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { success: false, error: "Network error - check DSN format" };
  }
};

/**
 * Set user context for error tracking
 * Call this after successful authentication
 */
export const setSentryUser = (user: {
  id: string;
  email?: string;
  organizationId?: string;
  organizationName?: string;
} | null): void => {
  if (user) {
    Sentry.setUser({
      id: user.id,
      email: user.email,
    });
    
    if (user.organizationId) {
      Sentry.setTag("organization_id", user.organizationId);
      Sentry.setTag("organization_name", user.organizationName || "Unknown");
    }
  } else {
    Sentry.setUser(null);
    Sentry.setTag("organization_id", undefined);
    Sentry.setTag("organization_name", undefined);
  }
};

/**
 * Capture a custom error with additional context
 */
export const captureError = (
  error: Error,
  context?: Record<string, unknown>
): void => {
  if (context) {
    Sentry.setContext("additional_info", context);
  }
  Sentry.captureException(error);
};

/**
 * Add a breadcrumb for debugging
 */
export const addBreadcrumb = (
  message: string,
  category: string,
  data?: Record<string, unknown>
): void => {
  Sentry.addBreadcrumb({
    message,
    category,
    level: "info",
    data,
  });
};

// Re-export Sentry for direct usage
export { Sentry };
