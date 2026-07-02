/**
 * POSErrorBoundary — Stage I (H5).
 *
 * Wraps the POS terminal route. Catches:
 *   1. React render errors (componentDidCatch)
 *   2. App-emitted errors via the `pos:error` channel (window CustomEvent)
 *
 * Renders a cashier-friendly action card (Try again / Call manager / Hardware offline)
 * — never raw stack traces. The boundary itself does not persist or play sounds:
 * `reportPOSError` already does that. For raw render errors we re-funnel through
 * the channel so the same persistence + sound path applies.
 */
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import {
  POS_ERROR_EVENT,
  reportPOSError,
  type POSErrorEventDetail,
} from "@/lib/pos/posErrorChannel";

interface Props {
  children: ReactNode;
}

interface State {
  current: POSErrorEventDetail | null;
}

export class POSErrorBoundary extends Component<Props, State> {
  state: State = { current: null };

  private listener = (e: Event) => {
    const ce = e as CustomEvent<POSErrorEventDetail>;
    if (!ce.detail) return;
    this.setState({ current: ce.detail });
  };

  componentDidMount(): void {
    if (typeof window !== "undefined") {
      window.addEventListener(POS_ERROR_EVENT, this.listener as EventListener);
    }
  }

  componentWillUnmount(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener(POS_ERROR_EVENT, this.listener as EventListener);
    }
  }

  static getDerivedStateFromError(_error: Error): Partial<State> {
    // We intentionally don't store the raw error — we wait for componentDidCatch
    // to re-funnel through `reportPOSError`, which sets `current` via the listener.
    return {};
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    reportPOSError({
      kind: "render",
      severity: "fatal",
      message: error.message,
      detail: { stack: error.stack, componentStack: info.componentStack },
    });
  }

  private handleDismiss = () => this.setState({ current: null });

  private handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render(): ReactNode {
    const { current } = this.state;
    if (!current) return this.props.children;

    const Icon =
      current.action === "call_manager"
        ? ShieldAlert
        : current.action === "hardware_offline"
          ? WifiOff
          : AlertTriangle;

    return (
      <>
        {this.props.children}
        <div
          role="alertdialog"
          aria-live="assertive"
          className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-4 pointer-events-none"
        >
          <Card className="pointer-events-auto w-full max-w-md border-destructive/40 shadow-lg">
            <CardHeader className="flex flex-row items-center gap-2 pb-2">
              <Icon className="h-5 w-5 text-destructive" />
              <CardTitle className="text-base">
                {current.action === "call_manager"
                  ? "Call a supervisor"
                  : current.action === "hardware_offline"
                    ? "Device offline"
                    : "Try again"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{current.cashierMessage}</p>
              <div className="flex justify-end gap-2">
                {current.action !== "call_manager" && (
                  <Button variant="outline" size="sm" onClick={this.handleDismiss}>
                    Dismiss
                  </Button>
                )}
                {current.kind === "render" ? (
                  <Button size="sm" onClick={this.handleReload}>
                    <RefreshCw className="h-4 w-4 mr-1.5" />
                    Reload terminal
                  </Button>
                ) : (
                  <Button size="sm" onClick={this.handleDismiss}>
                    OK
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </>
    );
  }
}
