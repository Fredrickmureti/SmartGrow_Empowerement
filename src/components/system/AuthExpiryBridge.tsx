/**
 * AuthExpiryBridge
 *
 * Wires the resilience-layer `authExpiryCoordinator` to React-land
 * side-effects: Sonner toast, Supabase local sign-out, and navigation
 * to `/login?reason=session_expired`. Mount ONCE inside the Router.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { authExpiryCoordinator } from "@/services/resilience/AuthExpiryCoordinator";
import { supabase } from "@/integrations/supabase/client";

export function AuthExpiryBridge(): null {
  const navigate = useNavigate();
  useEffect(() => {
    authExpiryCoordinator.configure({
      notify: ({ title, description }) => toast.error(title, { description }),
      signOut: async () => {
        try { await supabase.auth.signOut({ scope: "local" }); } catch { /* ignore */ }
      },
      redirect: () => {
        // Preserve where the user was so they can resume after sign-in.
        const current = window.location.pathname + window.location.search;
        const sep = current.includes("?") ? "&" : "?";
        const redirect = encodeURIComponent(current);
        navigate(`/login?reason=session_expired&redirect=${redirect}`.replace(sep, sep));
      },
    });
  }, [navigate]);
  return null;
}
