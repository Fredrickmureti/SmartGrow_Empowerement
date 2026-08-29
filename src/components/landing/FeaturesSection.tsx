import { Link } from "react-router-dom";
import { Sprout, Users, PiggyBank, GraduationCap, Store, ShieldCheck } from "lucide-react";

const PROGRAMMES = [
  {
    icon: Store,
    title: "Business loans",
    body: "KES 10,000 to 500,000 for stock, equipment or premises. Weekly or monthly repayment, set against real cash flow.",
  },
  {
    icon: Users,
    title: "Group lending",
    body: "Five to fifteen members guarantee one another. No collateral, no title deeds — the group is the security.",
  },
  {
    icon: Sprout,
    title: "Agriculture credit",
    body: "Input financing timed to the planting calendar, with repayment falling after harvest instead of during it.",
  },
  {
    icon: PiggyBank,
    title: "Savings accounts",
    body: "Voluntary and compulsory savings held safely, earning interest, withdrawable at your branch.",
  },
  {
    icon: GraduationCap,
    title: "Business training",
    body: "Record keeping, pricing and stock control sessions run free for every borrowing member.",
  },
  {
    icon: ShieldCheck,
    title: "Fair terms, written down",
    body: "One interest rate, disclosed up front. No hidden fees, no penalty stacking, no surprise charges.",
  },
];

export function FeaturesSection() {
  return (
    <section id="programmes" className="border-b border-border bg-secondary/40 py-20">
      <div className="container mx-auto px-4">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            What we offer
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Six products, built around how small businesses in our catchment
            actually earn and spend.
          </p>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {PROGRAMMES.map((item) => (
            <div key={item.title} className="bg-card p-8">
              <item.icon className="h-6 w-6 text-accent" strokeWidth={1.75} />
              <h3 className="mt-5 text-lg font-semibold text-card-foreground">
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {item.body}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-sm text-muted-foreground">
          Not sure which fits?{" "}
          <Link to="/contact" className="font-medium text-primary underline underline-offset-4">
            Speak to a loan officer
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
