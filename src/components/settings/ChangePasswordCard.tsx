/**
 * Personal account security: change your own sign-in password.
 *
 * This is self-service and deliberately available to every signed-in team
 * member — it is not an institution-administration control. Supabase Auth is
 * the authority: the password is changed on the account of the current
 * session, so no user can change anyone else's password from here.
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

const MIN_LENGTH = 8;

export function ChangePasswordCard() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const invalid = password.length < MIN_LENGTH || mismatch || confirm.length === 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword("");
      setConfirm("");
      toast.success("Password updated", {
        description: "Use your new password the next time you sign in.",
      });
    } catch (error) {
      toast.error("Could not change your password", {
        description:
          error instanceof Error ? error.message : "Please try again in a moment.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          Change password
        </CardTitle>
        <CardDescription>
          Set a new password for your own account. At least {MIN_LENGTH} characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              minLength={MIN_LENGTH}
              onChange={(e) => setPassword(e.target.value)}
            />
            {tooShort && (
              <p className="text-xs text-destructive">
                Use at least {MIN_LENGTH} characters.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch && (
              <p className="text-xs text-destructive">Both entries must match.</p>
            )}
          </div>
          <Button type="submit" disabled={invalid || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
