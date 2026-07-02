/**
 * AdminPinCard — platform-admin parity for the tenant PIN feature.
 *
 * Tenants can set a quick-login PIN under Settings → Security; admins had
 * no such surface, even though the underlying tables (`user_pins`,
 * `user_security_preferences`) are user-scoped, not tenant-scoped, and the
 * `usePINLogin` hook works for any authenticated user. We simply mount the
 * existing <PINSettings /> in the admin profile so admins get the same
 * capability without forking logic.
 *
 * Audit v2 (H3): the platform owner can disable PIN login for ALL admins
 * at once via `platform_settings.allow_admin_pin_login`. When that flag is
 * `false`, this card hides the PIN UI and shows an explanatory note so an
 * admin doesn't enable PIN locally only for it to be ignored at sign-in.
 *
 * NOTE: do not duplicate PIN business logic here. If the tenant PIN UX
 * changes, it should change in one place (PINSettings) and admins inherit
 * it automatically.
 */
import { useQuery } from "@tanstack/react-query";
import { ShieldOff } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PINSettings } from "@/components/settings/PINSettings";
import { supabase } from "@/integrations/supabase/client";

export function AdminPinCard() {
  const { data: allowAdminPin, isLoading } = useQuery({
    queryKey: ["platform-setting", "allow_admin_pin_login"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("setting_value")
        .eq("setting_key", "allow_admin_pin_login")
        .maybeSingle();
      if (error) {
        console.warn("[AdminPinCard] settings lookup failed:", error.message);
        return true; // safe default — show the PIN UI rather than hide it.
      }
      // Missing row = enabled (the default behaviour the migration shipped).
      if (!data?.setting_value) return true;
      return data.setting_value.toLowerCase() !== "false";
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (!allowAdminPin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="h-5 w-5 text-muted-foreground" />
            PIN login disabled
          </CardTitle>
          <CardDescription>
            The platform owner has disabled quick PIN login for all platform
            administrators. Sign in with your password each time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            This is a global security policy. Contact the platform owner if
            you believe PIN login should be re-enabled.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <PINSettings />;
}
