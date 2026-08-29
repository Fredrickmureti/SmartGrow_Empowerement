import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, Phone } from "lucide-react";
import heroImage from "@/assets/sge-hero.jpg";
import { useAuth } from "@/contexts/AuthContext";
import { BRAND } from "@/lib/brand";

const FACTS = [
  { value: "4,200+", label: "members served" },
  { value: "KES 180M", label: "disbursed since 2018" },
  { value: "97%", label: "on-time repayment" },
];

export function HeroSection() {
  const { user } = useAuth();

  return (
    <section className="relative border-b border-border bg-background">
      <div className="container mx-auto px-4 pt-28 pb-16 md:pt-32 md:pb-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-accent">
              Community microfinance
            </p>
            <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight tracking-tight text-foreground md:text-5xl">
              Capital that reaches the people banks walk past
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
              {BRAND.name} lends to small traders, smallholder farmers and savings
              groups — with terms people can actually repay, and an officer who
              knows the business by name.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" asChild>
                <Link to={user ? "/dashboard" : "/signup"}>
                  {user ? "Go to dashboard" : "Apply for a loan"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/contact">
                  <Phone className="mr-2 h-4 w-4" />
                  Talk to a loan officer
                </Link>
              </Button>
            </div>

            <dl className="mt-12 grid max-w-lg grid-cols-3 gap-6 border-t border-border pt-8">
              {FACTS.map((fact) => (
                <div key={fact.label}>
                  <dt className="text-2xl font-semibold text-foreground">
                    {fact.value}
                  </dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{fact.label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative">
            <img
              src={heroImage}
              alt="Members of a village savings and loan group meeting to record contributions"
              width={1408}
              height={1008}
              className="w-full rounded-lg border border-border object-cover shadow-sm"
            />
            <div className="mt-4 text-sm text-muted-foreground">
              Weekly group meeting, Machakos branch.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
