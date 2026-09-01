/**
 * Root entry.
 *
 * Smart Grow Empowerment is a single-institution, staff-operated system —
 * there is no public marketing surface. `/` simply resolves the signed-in
 * user's destination, or sends visitors to the login screen.
 */
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { resolvePostLoginDestination } from "@/lib/auth/postLoginRedirect";

const Index = () => {
  const { user, isLoading } = useAuth();
  const [destination, setDestination] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (isLoading || !user) {
      setDestination(null);
      return;
    }
    resolvePostLoginDestination({ user })
      .then((dest) => {
        if (!cancelled) setDestination(dest);
      })
      .catch(() => {
        if (!cancelled) setDestination("/dashboard");
      });
    return () => {
      cancelled = true;
    };
  }, [user, isLoading]);

  if (isLoading || (user && !destination)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <Navigate to={user && destination ? destination : "/login"} replace />;
};

export default Index;
