/**
 * App lifecycle action contract.
 *
 * The SaaS install/subscribe lifecycle has been retired in this
 * single-institution build; the type survives only because a few presentation
 * components accept an optional call-to-action descriptor.
 */
export interface AppLifecycleAction {
  intent: "open" | "install" | "subscribe" | "request";
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
  secondary?: { label: string; onClick: () => void | Promise<void> };
}
