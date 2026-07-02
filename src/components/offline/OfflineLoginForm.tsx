/**
 * Offline Login Form Component
 * Special login form for Electron desktop app when offline
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, WifiOff, AlertCircle } from "lucide-react";
import { useOfflineAuth } from "@/hooks/useOfflineAuth";

interface OfflineLoginFormProps {
  cachedEmail: string | null;
  onBackToOnline: () => void;
}

export function OfflineLoginForm({
  cachedEmail,
  onBackToOnline,
}: OfflineLoginFormProps) {
  const [email, setEmail] = useState(cachedEmail || "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const { loginOffline } = useOfflineAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const result = await loginOffline(email, password);

    if (result.success) {
      toast({
        title: "Logged in offline",
        description: "You're working in offline mode. Data will sync when connected.",
      });
      navigate("/pos/terminal");
    } else {
      setError(result.error || "Failed to login offline");
    }

    setIsLoading(false);
  };

  return (
    <div className="space-y-6">
      <Alert variant="default" className="bg-yellow-500/10 border-yellow-500/50">
        <WifiOff className="h-4 w-4 text-yellow-600" />
        <AlertDescription className="text-yellow-700">
          You're offline. Login with your cached credentials to continue working.
        </AlertDescription>
      </Alert>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="offline-email">Email</Label>
          <Input
            id="offline-email"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={!!cachedEmail}
            className="h-11"
          />
          {cachedEmail && (
            <p className="text-xs text-muted-foreground">
              Using cached credentials for this account
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="offline-password">Password</Label>
          <div className="relative">
            <Input
              id="offline-password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="h-11 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full h-11" disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Verifying...
            </>
          ) : (
            <>
              <WifiOff className="mr-2 h-4 w-4" />
              Login Offline
            </>
          )}
        </Button>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onBackToOnline}
        >
          Wait for connection
        </Button>
      </form>

      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Offline mode is only available for previously logged-in users on this device.
        </p>
      </div>
    </div>
  );
}
