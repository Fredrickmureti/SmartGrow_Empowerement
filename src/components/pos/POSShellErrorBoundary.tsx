/**
 * POSShellErrorBoundary — workspace-shell render guard.
 *
 * Different role from `POSErrorBoundary` (which is the cashier-facing
 * action card on the terminal). This boundary wraps the inner outlet of
 * the POS workspace shell so that a render-time throw in any sub-page
 * (Reports, Settings, Hardware Devices, …) shows an actionable card
 * INSTEAD of a blank white screen — the previous failure mode for the
 * `/pos/hardware-devices` blank in Electron.
 *
 * Critically, unlike `POSErrorBoundary` this boundary STOPS rendering
 * children once an error is captured. A boundary that keeps re-rendering
 * the throwing subtree will re-throw on every commit and React eventually
 * unmounts the whole tree to bare DOM — exactly the symptom we observed.
 */
import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  /** Stable key — when it changes the boundary resets (use route key). */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class POSShellErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    this.setState({ info: info.componentStack });
    // Surface to console + Sentry sink (root SentryErrorBoundary upstream
    // already wires Sentry).
    // eslint-disable-next-line no-console
    console.error("[pos-shell] render error", error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  private handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private handleReset = () => this.setState({ error: null, info: null });

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="p-4 md:p-6">
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-row items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <CardTitle className="text-base">This page failed to load</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The POS workspace caught a render error so the rest of the app stays
              usable. The error message is shown below — please include it when
              reporting this to support.
            </p>
            <pre className="text-xs bg-muted/40 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
              {error.name}: {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
              {info ? `\n\nComponent stack:${info}` : ""}
            </pre>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={this.handleReset}>
                Try again
              </Button>
              <Button size="sm" onClick={this.handleReload}>
                <RefreshCw className="h-4 w-4 mr-1.5" />
                Reload
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}

export default POSShellErrorBoundary;