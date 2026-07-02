import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Database } from "@/integrations/supabase/types";

type AppRole = Database["public"]["Enums"]["app_role"];

export interface Invitation {
  id: string;
  email: string;
  role: AppRole;
  token: string;
  expires_at: string;
  accepted_at: string | null;
  organization: {
    id: string;
    name: string;
  } | null;
}

/**
 * Server-resolved invitation route. The page no longer asks the user to
 * pick "I have an account / I'm new here" — `resolve-invitation` does that
 * lookup against `auth.users` and returns one of these branches. See
 * docs/audit/2026-06-13-invitation-architecture.md.
 */
export type InvitationRoute =
  | "signup"
  | "login"
  | "auto_accept"
  | "already_member";

interface UseInvitationReturn {
  invitation: Invitation | null;
  isLoading: boolean;
  error: string | null;
  isExpired: boolean;
  isAlreadyAccepted: boolean;
  route: InvitationRoute | null;
  alreadyMemberOfOrg: boolean;
  validateToken: (token: string) => Promise<boolean>;
  acceptInvitation: () => Promise<{ success: boolean; error?: string; organization_id?: string }>;
}

export function useInvitation(token: string | null): UseInvitationReturn {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpired, setIsExpired] = useState(false);
  const [isAlreadyAccepted, setIsAlreadyAccepted] = useState(false);
  const [route, setRoute] = useState<InvitationRoute | null>(null);
  const [alreadyMemberOfOrg, setAlreadyMemberOfOrg] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (token) {
      validateToken(token);
    } else {
      setIsLoading(false);
      setError("No invitation token provided");
    }
  }, [token]);

  const validateToken = async (inviteToken: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);
    setIsExpired(false);
    setIsAlreadyAccepted(false);
    setRoute(null);
    setAlreadyMemberOfOrg(false);

    try {
      // validate-invitation now returns BOTH validity and a server-decided
      // `route` (signup | login | auto_accept | already_member). The
      // previous separate `resolve-invitation` function was folded back
      // into this endpoint because the edge-function quota is capped and
      // two functions for the same lifecycle was unjustified.
      const { data, error: fnError } = await supabase.functions.invoke("validate-invitation", {
        body: { token: inviteToken },
      });

      if (fnError) {
        setError("Failed to validate invitation. Please try again.");
        setInvitation(null);
        return false;
      }

      if (!data.valid) {
        setError(data.error || "Invalid invitation");
        setIsExpired(data.isExpired || false);
        setIsAlreadyAccepted(data.isAlreadyAccepted || false);

        if (data.invitation) {
          setInvitation(data.invitation as Invitation);
        } else {
          setInvitation(null);
        }
        return false;
      }

      setInvitation(data.invitation as Invitation);
      setRoute((data.route as InvitationRoute) ?? null);
      setAlreadyMemberOfOrg(!!data.alreadyMemberOfOrg);
      return true;
    } catch (err: any) {
      setError(err.message || "Failed to validate invitation");
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const acceptInvitation = async (): Promise<{ success: boolean; error?: string; organization_id?: string }> => {
    if (!invitation || !user) {
      return { success: false, error: "No invitation or user session" };
    }

    // Verify email matches (case-insensitive)
    if (user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
      return { 
        success: false, 
        error: `This invitation was sent to ${invitation.email}. Please sign in with that email address.` 
      };
    }

    try {
      // Identity is derived from the Authorization JWT server-side.
      // We must NOT pass user_id from the browser — that was an
      // impersonation vector closed in 2026-06-13's re-audit.
      const { data, error: fnError } = await supabase.functions.invoke("accept-invitation", {
        body: { token: invitation.token },
      });

      if (fnError) {
        return { success: false, error: fnError.message };
      }

      if (data?.success === false || data?.error) {
        return { success: false, error: data?.error || "Failed to accept invitation" };
      }

      return {
        success: true,
        organization_id: data?.organization_id,
      };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to accept invitation" };
    }
  };

  return {
    invitation,
    isLoading,
    error,
    isExpired,
    isAlreadyAccepted,
    route,
    alreadyMemberOfOrg,
    validateToken,
    acceptInvitation,
  };
}
