/**
 * Sentry Error Boundary Component
 * 
 * Catches React component errors and reports them to Sentry.
 * Shows a user-friendly fallback UI with recovery options.
 * Detects stale chunk errors and shows a "new version available" prompt.
 */

import React from "react";
import * as Sentry from "@sentry/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, RefreshCw, Home, Bug, Download } from "lucide-react";

function isChunkLoadError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("failed to fetch dynamically imported module") ||
    msg.includes("loading chunk") ||
    msg.includes("loading css chunk") ||
    msg.includes("dynamically imported module")
  );
}

interface FallbackProps {
  error: Error;
  componentStack: string | null;
  eventId: string | null;
  resetError: () => void;
}

const ChunkErrorFallback: React.FC = () => {
  const handleUpdate = () => {
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Download className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">New version available</CardTitle>
          <CardDescription>
            The app has been updated. Please reload to get the latest version.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleUpdate} className="w-full">
            <RefreshCw className="mr-2 h-4 w-4" />
            Reload now
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

const ErrorFallback: React.FC<FallbackProps> = ({
  error,
  resetError,
  eventId,
}) => {
  const handleReportIssue = () => {
    if (eventId) {
      (Sentry as any).showReportDialog({ eventId });
    }
  };

  const handleGoHome = () => {
    window.location.href = "/dashboard";
  };

  const handleRefresh = () => {
    resetError();
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle className="text-xl">Something went wrong</CardTitle>
          <CardDescription>
            We've been notified and are working on a fix.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground transition-colors">
              Technical details
            </summary>
            <pre className="mt-2 p-3 bg-muted rounded-md text-xs overflow-auto max-h-32">
              {error.message}
            </pre>
          </details>

          <div className="flex flex-col gap-2">
            <Button onClick={handleRefresh} className="w-full">
              <RefreshCw className="mr-2 h-4 w-4" />
              Try again
            </Button>
            
            <Button variant="outline" onClick={handleGoHome} className="w-full">
              <Home className="mr-2 h-4 w-4" />
              Go to Dashboard
            </Button>
            
            {eventId && (
              <Button variant="ghost" onClick={handleReportIssue} className="w-full">
                <Bug className="mr-2 h-4 w-4" />
                Report this issue
              </Button>
            )}
          </div>

          {eventId && (
            <p className="text-xs text-center text-muted-foreground">
              Error ID: <code className="bg-muted px-1 rounded">{eventId}</code>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

interface SentryErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const SentryErrorBoundary: React.FC<SentryErrorBoundaryProps> = ({
  children,
  fallback,
}) => {
  return (
    <Sentry.ErrorBoundary
      fallback={(props) => {
        const errorObj = props.error instanceof Error 
          ? props.error 
          : new Error(String(props.error));

        // Show friendly "update available" UI for chunk load errors
        if (isChunkLoadError(errorObj)) {
          return <ChunkErrorFallback />;
        }

        return fallback ? <>{fallback}</> : (
          <ErrorFallback 
            error={errorObj}
            componentStack={props.componentStack}
            eventId={props.eventId}
            resetError={props.resetError}
          />
        );
      }}
      beforeCapture={(scope) => {
        scope.setLevel("error");
        scope.setTag("error_boundary", "true");
      }}
      onError={(error, componentStack) => {
        console.error("[SentryErrorBoundary] Caught error:", error);
        console.error("[SentryErrorBoundary] Component stack:", componentStack);
      }}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
};

export default SentryErrorBoundary;
