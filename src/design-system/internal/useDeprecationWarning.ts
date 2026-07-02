/**
 * Shared runtime deprecation warning for legacy navigation primitives.
 * Logs once per component name per page load.
 */
import { useEffect } from "react";

const warned = new Set<string>();

export function useDeprecationWarning(
  componentName: string,
  replacement: string,
) {
  useEffect(() => {
    if (warned.has(componentName)) return;
    warned.add(componentName);
    // eslint-disable-next-line no-console
    console.warn(
      `[deprecated] <${componentName}> is being phased out. Use ${replacement} from "@/design-system" instead. See docs/design-system.md.`,
    );
  }, [componentName, replacement]);
}
