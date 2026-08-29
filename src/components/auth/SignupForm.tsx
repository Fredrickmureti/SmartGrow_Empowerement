import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Loader2, Check, X, ArrowRight, ArrowLeft, Building2, Globe, Briefcase } from "lucide-react";
import { businessTypes, industryTypes } from "@/lib/countryCurrency";
import { useCountries, getCurrencyByCountryCode } from "@/hooks/useCountries";
import { supabase } from "@/integrations/supabase/client";
import { AppSelectionStep, getDefaultSelectedApps } from "@/components/onboarding/AppSelectionStep";
import { TeamInviteStep, type TeamInvitee } from "@/components/onboarding/TeamInviteStep";
import { SignupRecoveryCardInline } from "@/components/auth/SignupRecoveryCardInline";
import { normalizeError } from "@/services/resilience";

const TOTAL_STEPS = 4;

export function SignupForm() {
  // Step 1 - Account
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  
  // Step 2 - Company (Odoo-aligned: one question, one source of truth).
  // The "Workspace" tenant is created behind the scenes from the same name.
  const [companyName, setCompanyName] = useState("");
  const [country, setCountry] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [industry, setIndustry] = useState("");
  const [countrySearch, setCountrySearch] = useState("");
  
  // Step 3 - Apps
  const [selectedApps, setSelectedApps] = useState<string[]>(getDefaultSelectedApps());
  
  // Step 4 - Team Invites
  const [teamInvitees, setTeamInvitees] = useState<TeamInvitee[]>([]);
  
  // UI state
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  const { countries } = useCountries();
  const filteredCountries = countrySearch
    ? countries.filter(c => 
        c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
        c.code.toLowerCase().includes(countrySearch.toLowerCase())
      )
    : countries;

  const selectedCountryData = countries.find(c => c.code === country);

  const passwordRequirements = [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Contains uppercase letter", met: /[A-Z]/.test(password) },
    { label: "Contains lowercase letter", met: /[a-z]/.test(password) },
    { label: "Contains a number", met: /\d/.test(password) },
  ];

  const allRequirementsMet = passwordRequirements.every((req) => req.met);

  const handleStep1Submit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!allRequirementsMet) {
      toast({
        title: "Password requirements not met",
        description: "Please ensure your password meets all requirements.",
        variant: "destructive",
      });
      return;
    }

    setStep(2);
  };

  const handleStep2Submit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!companyName.trim() || !country) {
      toast({
        title: "Missing information",
        description: "Please enter your company name and country.",
        variant: "destructive",
      });
      return;
    }

    setStep(3);
  };

  const handleStep3Next = () => {
    setStep(4);
  };

  // Probe the actual signup outcome by asking the edge function whether the
  // email now exists. Used both as a pre-check AND as a post-failure probe
  // — Supabase auth signup often succeeds server-side even when the
  // response never reaches us (ERR_CONNECTION_CLOSED / Failed to fetch).
  type ProbeBranch =
    | { kind: "platform_invitation"; token: string }
    | { kind: "is_platform_admin" }
    | { kind: "verified" }
    | { kind: "pending_verification" }
    | { kind: "not_found" };

  const probeEmailState = async (normalizedEmail: string): Promise<ProbeBranch | null> => {
    try {
      const { data: availability, error: checkError } =
        await supabase.functions.invoke("check-email-availability", {
          body: { email: normalizedEmail },
        });
      if (checkError) return null;
      if (
        availability?.pending_platform_invitation &&
        availability?.pending_platform_invitation_token
      ) {
        return { kind: "platform_invitation", token: availability.pending_platform_invitation_token };
      }
      if (availability?.exists && !availability?.reaped) {
        if (availability.persona === "platform_admin") return { kind: "is_platform_admin" };
        if (availability.confirmed) return { kind: "verified" };
        return { kind: "pending_verification" };
      }
      return { kind: "not_found" };
    } catch (e) {
      console.warn("[SignupForm] probeEmailState failed:", e);
      return null;
    }
  };

  // Returns true if it routed the user; false means "fall through to signUp".
  const routeFromProbe = async (
    branch: ProbeBranch,
    normalizedEmail: string,
    opts: { uncertain?: boolean } = {},
  ): Promise<boolean> => {
    if (branch.kind === "verified") {
      toast({
        title: "You already have an account",
        description: "Sign in instead — we've taken you to the login page.",
      });
      setIsLoading(false);
      navigate(`/login?email=${encodeURIComponent(normalizedEmail)}`);
      return true;
    }
    if (branch.kind === "pending_verification") {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: normalizedEmail,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (resendError && !opts.uncertain) {
        toast({
          title: "Couldn't resend verification",
          description: normalizeError(resendError).message,
          variant: "destructive",
        });
        setIsLoading(false);
        return true;
      }
      toast({
        title: opts.uncertain ? "Account created — check your email" : "Verification email resent",
        description: opts.uncertain
          ? "Your signup completed, but the response was interrupted. We've made sure a verification link is on the way."
          : "You started signing up earlier but didn't verify. We've sent a fresh link.",
      });
      setIsLoading(false);
      navigate("/verify-email", { state: { email: normalizedEmail, uncertain: !!opts.uncertain } });
      return true;
    }
    return false;
  };

  // 60s client-side cooldown keyed on normalized email — kills the
  // "user retries 7 times after a dropped response" pattern from auth logs.
  const SIGNUP_COOLDOWN_MS = 60_000;
  const cooldownKey = (em: string) => `signup:lastAttempt:${em}`;
  const isInCooldown = (em: string) => {
    try {
      const raw = sessionStorage.getItem(cooldownKey(em));
      if (!raw) return false;
      return Date.now() - Number(raw) < SIGNUP_COOLDOWN_MS;
    } catch { return false; }
  };
  const markAttempt = (em: string) => {
    try { sessionStorage.setItem(cooldownKey(em), String(Date.now())); } catch { /* noop */ }
  };

  const handleFinalSubmit = async () => {
    setIsLoading(true);

    const currency = getCurrencyByCountryCode(countries, country);
    const normalizedEmail = email.trim().toLowerCase();

    // ── Cooldown branch: previous attempt fired in the last 60s. Probe
    // instead of re-calling signUp; route on actual state.
    if (isInCooldown(normalizedEmail)) {
      const branch = await probeEmailState(normalizedEmail);
      if (branch && (await routeFromProbe(branch, normalizedEmail, { uncertain: true }))) return;
      toast({
        title: "Just a moment",
        description: "We're still confirming your previous attempt. Check your inbox for a verification email before retrying.",
      });
      setIsLoading(false);
      navigate("/verify-email", { state: { email: normalizedEmail, uncertain: true } });
      return;
    }

    // ── Pre-check.
    const preBranch = await probeEmailState(normalizedEmail);
    if (preBranch && preBranch.kind !== "not_found") {
      if (await routeFromProbe(preBranch, normalizedEmail)) return;
    }

    // Session hygiene: a previous half-completed attempt may have left a
    // local session in storage. supabase.auth.signUp on top of an existing
    // session can return a confusingly "successful" user object that does
    // not match the new email. Clear local state before entering a fresh
    // public signup journey. `scope: 'local'` does not revoke server-side
    // sessions for other devices.
    try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* noop */ }

    // ── Attempt signUp. Wrapped so transport-level failures don't fall
    // through to a generic error toast — they probe for actual outcome.
    markAttempt(normalizedEmail);
    let signUpData: Awaited<ReturnType<typeof supabase.auth.signUp>>["data"] | null = null;
    let signUpError: unknown = null;
    try {
      const res = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: {
            full_name: fullName,
            pending_company_name: companyName.trim(),
            pending_country: country,
            pending_currency: currency,
            pending_business_type: businessType || null,
            pending_industry: industry || null,
            pending_selected_apps: selectedApps,
            pending_team_invitees: teamInvitees,
            onboarding_completed: false,
          },
        },
      });
      signUpData = res.data;
      signUpError = res.error;
    } catch (thrown) {
      signUpError = thrown;
    }

    if (signUpError) {
      const normalized = normalizeError(signUpError);
      if (
        normalized.kind === "offline" ||
        normalized.kind === "timeout" ||
        normalized.kind === "server_unavailable"
      ) {
        // Transport-level failure — server may have succeeded. Probe.
        const postBranch = await probeEmailState(normalizedEmail);
        if (postBranch && (await routeFromProbe(postBranch, normalizedEmail, { uncertain: true }))) return;
        toast({
          title: "We couldn't confirm your signup",
          description: "Check your inbox for a verification email before trying again — retrying may create duplicates.",
        });
        setIsLoading(false);
        navigate("/verify-email", { state: { email: normalizedEmail, uncertain: true } });
        return;
      }
      toast({
        title: "Error creating account",
        description: normalized.message,
        variant: "destructive",
      });
      setIsLoading(false);
      return;
    }

    // Defense in depth: identities=[] means email is already registered
    // (Supabase anti-enumeration behaviour).
    if (signUpData?.user && (signUpData.user.identities?.length ?? 0) === 0) {
      toast({
        title: "You already have an account",
        description: "Sign in instead — we've taken you to the login page.",
      });
      setIsLoading(false);
      navigate(`/login?email=${encodeURIComponent(normalizedEmail)}`);
      return;
    }

    setIsLoading(false);
    navigate("/verify-email", { state: { email: normalizedEmail } });
  };

  return (
    <div className="space-y-6">
      {/* Step Indicator */}
      <div className="flex items-center justify-center gap-2 mb-6">
        {[1, 2, 3, 4].map((stepNum, index) => (
          <div key={stepNum} className="flex items-center">
            <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${step >= stepNum ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {stepNum}
            </div>
            {index < 3 && (
              <div className={`w-6 h-0.5 ${step > stepNum ? "bg-primary" : "bg-muted"}`} />
            )}
          </div>
        ))}
      </div>

      {step === 1 ? (
        <form onSubmit={handleStep1Submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              type="text"
              placeholder="John Doe"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">Your personal name — not your business name</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Create a strong password"
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
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {password && (
              <div className="mt-3 space-y-2">
                {passwordRequirements.map((req) => (
                  <div key={req.label} className="flex items-center gap-2 text-sm">
                    {req.met ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <X className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className={req.met ? "text-success" : "text-muted-foreground"}>
                      {req.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button type="submit" className="w-full h-11" disabled={!allRequirementsMet || !fullName || !email}>
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-primary font-medium hover:underline">
              Sign in
            </Link>
          </p>

          {/*
            Audit v2 (C2): Stuck-signup recovery on the signup screen too.
            A user whose previous attempt half-failed is most likely to
            try signing up again first — this gives them a one-click way
            out without having to figure out it lives on /login.
          */}
          <RecoveryAccordion email={email} />
        </form>
      ) : step === 2 ? (
        <form onSubmit={handleStep2Submit} className="space-y-5">
          <div className="text-center mb-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <Building2 className="w-6 h-6 text-primary" />
            </div>
            <h3 className="font-semibold">Set up your company</h3>
            <p className="text-sm text-muted-foreground">
              This is the legal entity that owns your books and appears on every invoice.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="companyName" className="flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Company Name *
            </Label>
            <Input
              id="companyName"
              type="text"
              placeholder="Acme Corporation Ltd"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              required
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              Appears on invoices, journals and reports. You can refine the legal name later in settings.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="country" className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Country *
            </Label>
            <Select value={country} onValueChange={setCountry} required>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select your country" />
              </SelectTrigger>
              <SelectContent>
                <div className="px-2 pb-2">
                  <Input
                    placeholder="Search countries..."
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="max-h-[200px] overflow-y-auto">
                  {filteredCountries.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      <span className="flex items-center gap-2">
                        {c.name}
                        <span className="text-muted-foreground text-xs">({c.currency})</span>
                      </span>
                    </SelectItem>
                  ))}
                </div>
              </SelectContent>
            </Select>
            {selectedCountryData && (
              <p className="text-xs text-muted-foreground">
                Base currency: <strong>{selectedCountryData.currency}</strong>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="businessType">Business Type (optional)</Label>
            <Select value={businessType} onValueChange={setBusinessType}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select business type" />
              </SelectTrigger>
              <SelectContent>
                {businessTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="industry">Industry (optional)</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select your industry" />
              </SelectTrigger>
              <SelectContent>
                {industryTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Tailors templates, dashboards and terminology to your sector.
            </p>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
            You can add more companies (legal entities) and branches later from
            the in-app Company switcher — Odoo-style.
          </p>

          <div className="flex gap-3">
            <Button type="button" variant="outline" className="flex-1 h-11" onClick={() => setStep(1)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <Button type="submit" className="flex-1 h-11" disabled={!companyName.trim() || !country}>
              Continue
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </form>
      ) : step === 3 ? (
        <AppSelectionStep
          selectedApps={selectedApps}
          onSelectedAppsChange={setSelectedApps}
          onBack={() => setStep(2)}
          onNext={handleStep3Next}
          isLoading={false}
        />
      ) : (
        <TeamInviteStep
          invitees={teamInvitees}
          onInviteesChange={setTeamInvitees}
          onBack={() => setStep(3)}
          onNext={handleFinalSubmit}
          onSkip={handleFinalSubmit}
          isLoading={isLoading}
        />
      )}

      {step === 4 && (
        <p className="text-center text-xs text-muted-foreground">
          By creating an account, you agree to our{" "}
          <Link to="/terms" className="hover:underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link to="/privacy" className="hover:underline">
            Privacy Policy
          </Link>
        </p>
      )}
    </div>
  );
}

function RecoveryAccordion({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline w-full text-center"
      >
        {open ? "Hide recovery options" : "Previous signup got stuck? Recover it"}
      </button>
      {open && (
        <div className="mt-3">
          <SignupRecoveryCardInline email={email || null} />
        </div>
      )}
    </div>
  );
}

