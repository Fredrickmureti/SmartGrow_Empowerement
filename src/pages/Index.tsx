import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { resolvePostLoginDestination } from "@/lib/auth/postLoginRedirect";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { HeroSection } from "@/components/landing/HeroSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { HowItWorksSection } from "@/components/landing/HowItWorksSection";
import { CTASection, FooterSection } from "@/components/landing/CTASection";

import { Loader2 } from "lucide-react";

const Index = () => {
  const { user, isLoading } = useAuth();
  const [destination, setDestination] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Handle hash fragments on root path (fallback from Supabase redirect)
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("access_token") && hash.includes("type=signup")) {
      if (import.meta.env.DEV) {
        console.debug("[Index] Detected signup tokens in hash, forwarding to onboarding-setup");
      }
      // Forward the hash to the onboarding handler
      window.location.replace("/onboarding-setup" + hash);
    }
  }, []);

  // Resolve where the authenticated user should land. Platform admins are
  // routed to /admin-management instead of being forced through onboarding.
  useEffect(() => {
    let cancelled = false;
    if (isLoading || !user) {
      setDestination(null);
      return;
    }
    setResolving(true);
    resolvePostLoginDestination({ user })
      .then((dest) => { if (!cancelled) setDestination(dest); })
      .finally(() => { if (!cancelled) setResolving(false); });
    return () => { cancelled = true; };
  }, [user, isLoading]);

  // Show loading while auth is being determined or destination is being resolved.
  if (isLoading || (user && resolving && !destination)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (user && destination) {
    return <Navigate to={destination} replace />;
  }

  // Show landing page for non-authenticated users
  return (
    <div className="min-h-screen">
      <LandingHeader />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <CTASection />
      <FooterSection />
    </div>
  );
};

export default Index;
