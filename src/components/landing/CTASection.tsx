import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, MapPin, Mail, Phone } from "lucide-react";
import { ScheduleDemoDialog } from "./ScheduleDemoDialog";
import { useAuth } from "@/contexts/AuthContext";
import { BRAND } from "@/lib/brand";

export function CTASection() {
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const { user } = useAuth();

  return (
    <>
      <section className="bg-primary py-20 text-primary-foreground">
        <div className="container mx-auto px-4">
          <div className="grid gap-10 md:grid-cols-2 md:items-end">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
                Start where you are
              </h2>
              <p className="mt-4 max-w-lg text-lg leading-relaxed text-primary-foreground/80">
                Bring your ID and your business. We will do the rest with you —
                assessment, savings account and a first cycle you can carry.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row md:justify-end">
              <Button size="lg" variant="secondary" asChild>
                <Link to={user ? "/dashboard" : "/signup"}>
                  {user ? "Go to dashboard" : "Become a member"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10"
                onClick={() => setShowScheduleDialog(true)}
              >
                Book a branch visit
              </Button>
            </div>
          </div>
        </div>
      </section>

      <ScheduleDemoDialog
        open={showScheduleDialog}
        onOpenChange={setShowScheduleDialog}
      />
    </>
  );
}

export function FooterSection() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-secondary/50 py-14">
      <div className="container mx-auto px-4">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                {BRAND.initials}
              </span>
              <span className="text-lg font-semibold text-foreground">
                {BRAND.name}
              </span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {BRAND.description}
            </p>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-foreground">Explore</h4>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li><a href="/#programmes" className="hover:text-foreground">Loan products</a></li>
              <li><a href="/#how-it-works" className="hover:text-foreground">How it works</a></li>
              <li><Link to="/about" className="hover:text-foreground">About us</Link></li>
              <li><Link to="/help" className="hover:text-foreground">Help centre</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-foreground">Reach us</h4>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                Head office, Machakos Town
              </li>
              <li className="flex items-start gap-2">
                <Phone className="mt-0.5 h-4 w-4 shrink-0" />
                {BRAND.phone}
              </li>
              <li className="flex items-start gap-2">
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                {BRAND.email}
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p>© {currentYear} {BRAND.name}. All rights reserved.</p>
          <div className="flex gap-6">
            <a href="/privacy" className="hover:text-foreground">Privacy</a>
            <a href="/terms" className="hover:text-foreground">Terms</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
