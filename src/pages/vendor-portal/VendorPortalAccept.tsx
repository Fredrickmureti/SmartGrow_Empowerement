/**
 * Vendor Portal Accept Invitation page
 * Allows vendor to create account using invitation token
 */
import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle, XCircle, Package } from "lucide-react";

interface InvitationData {
  email: string;
  contact: { name: string; company: string | null } | null;
  organization: { name: string } | null;
}

export default function VendorPortalAccept() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");

  const [isValidating, setIsValidating] = useState(true);
  const [isValid, setIsValid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationData | null>(null);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAccepted, setIsAccepted] = useState(false);

  useEffect(() => {
    if (token) validateToken(token);
    else {
      setIsValidating(false);
      setError("No invitation token provided");
    }
  }, [token]);

  const validateToken = async (t: string) => {
    setIsValidating(true);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("vendor-portal-accept", {
        body: { action: "validate", token: t },
      });
      
      if (fnErr) {
        setError("Failed to validate invitation");
        return;
      }
      if (!data?.valid) {
        setError(data?.error || "Invalid invitation");
        return;
      }
      setIsValid(true);
      setInvitation({
        email: data.invitation.email,
        contact: data.invitation.contact,
        organization: data.invitation.organization,
      });
    } catch {
      setError("Failed to validate invitation");
    } finally {
      setIsValidating(false);
    }
  };

  const handleAccept = async () => {
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "vendor-portal-accept",
        { body: { action: "accept", token, password } }
      );

      if (fnErr) {
        setError("Failed to create account");
        return;
      }
      if (data?.error) {
        setError(data.error);
        return;
      }

      setIsAccepted(true);
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isValidating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isAccepted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12 text-center space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <h3 className="text-xl font-semibold">Account Created!</h3>
            <p className="text-muted-foreground">
              Your vendor portal account has been set up. You can now sign in.
            </p>
            <Button onClick={() => navigate("/login")}>
              Go to Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-12 text-center space-y-4">
            <XCircle className="h-12 w-12 text-destructive" />
            <h3 className="text-xl font-semibold">Invalid Invitation</h3>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-12 h-12 mx-auto rounded-xl bg-orange-500 flex items-center justify-center mb-3">
            <Package className="h-6 w-6 text-white" />
          </div>
          <CardTitle>Vendor Portal Invitation</CardTitle>
          <CardDescription>
            {invitation?.organization?.name} has invited you to their vendor portal
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 bg-muted rounded-lg">
            <p className="text-sm">
              <span className="text-muted-foreground">Name:</span>{" "}
              <span className="font-medium">{invitation?.contact?.name}</span>
            </p>
            <p className="text-sm mt-1">
              <span className="text-muted-foreground">Email:</span>{" "}
              <span className="font-medium">{invitation?.email}</span>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Create Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm Password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button
            className="w-full"
            onClick={handleAccept}
            disabled={isSubmitting || !password || !confirmPassword}
          >
            {isSubmitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating Account...</>
            ) : (
              "Create Account & Accept"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
