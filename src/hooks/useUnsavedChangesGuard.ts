/**
 * Router-agnostic navigation blocker + tab-close warning when a form is dirty.
 *
 * Why not `useBlocker`? `useBlocker` only works inside a data router
 * (`createBrowserRouter` + `<RouterProvider>`). This app uses the classic
 * `<BrowserRouter>`, so `useBlocker` throws on mount. Instead we intercept
 * navigation intent at the browser layer:
 *
 *  - Anchor clicks (capture phase, document-level) — same-origin SPA links
 *    are paused, the AlertDialog asks for confirmation, and on confirm we
 *    `navigate(href)` via react-router.
 *  - `popstate` (back / forward) — we push the current URL back on, ask
 *    for confirmation, and `history.back()` once (one-shot suppression).
 *  - `beforeunload` — covers tab close, refresh, external nav.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export interface UnsavedChangesGuard {
  /** True when a navigation is paused waiting for the user. */
  isBlocked: boolean;
  /** Allow the paused navigation to proceed (discard changes). */
  confirm: () => void;
  /** Cancel the paused navigation (keep editing). */
  cancel: () => void;
}

export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const navigate = useNavigate();
  const [isBlocked, setIsBlocked] = useState(false);
  const pendingRef = useRef<{ kind: "push"; to: string } | { kind: "pop" } | null>(null);
  // One-shot flag set just before we programmatically navigate so our own
  // synthetic popstate / anchor click does not re-trigger the dialog.
  const allowOnceRef = useRef(false);

  // beforeunload: tab close / refresh / external nav.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Anchor-click interception (in-app SPA links).
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (allowOnceRef.current) return;
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!target) return;
      // Skip downloads, new-tab, external origins.
      if (target.target && target.target !== "" && target.target !== "_self") return;
      if (target.hasAttribute("download")) return;
      const href = target.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let url: URL;
      try { url = new URL(href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      pendingRef.current = { kind: "push", to: url.pathname + url.search + url.hash };
      setIsBlocked(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  // popstate: back / forward button.
  useEffect(() => {
    if (!dirty) return;
    // Pin a sentinel state so we can detect "user pressed back".
    const sentinelKey = "__unsavedGuardSentinel";
    window.history.replaceState({ ...(window.history.state || {}), [sentinelKey]: true }, "");
    const onPop = () => {
      if (allowOnceRef.current) {
        allowOnceRef.current = false;
        return;
      }
      // Re-push current URL so the address bar stays put while we ask.
      window.history.pushState({ ...(window.history.state || {}), [sentinelKey]: true }, "", window.location.href);
      pendingRef.current = { kind: "pop" };
      setIsBlocked(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [dirty]);

  const confirm = () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setIsBlocked(false);
    if (!pending) return;
    allowOnceRef.current = true;
    if (pending.kind === "push") {
      navigate(pending.to);
    } else {
      window.history.back();
    }
  };

  const cancel = () => {
    pendingRef.current = null;
    setIsBlocked(false);
  };

  return { isBlocked, confirm, cancel };
}
