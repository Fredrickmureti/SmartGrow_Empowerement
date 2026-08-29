import memberImage from "@/assets/sge-member.jpg";

const STEPS = [
  {
    step: "01",
    title: "Join a group or visit a branch",
    body: "Bring your ID and a short description of your business. Group members register together.",
  },
  {
    step: "02",
    title: "Assessment with an officer",
    body: "We look at your daily takings, stock and existing obligations, then agree a limit you can carry.",
  },
  {
    step: "03",
    title: "Disbursement within a week",
    body: "Funds go to your mobile money or savings account once your group approves the application.",
  },
  {
    step: "04",
    title: "Repay, then borrow larger",
    body: "Every cycle completed on time raises your limit. Your record travels with you across branches.",
  },
];

export function HowItWorksSection() {
  return (
    <section id="how-it-works" className="border-b border-border bg-background py-20">
      <div className="container mx-auto px-4">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              How a loan works
            </h2>
            <ol className="mt-10 space-y-8">
              {STEPS.map((s) => (
                <li key={s.step} className="flex gap-5">
                  <span className="mt-1 font-mono text-sm text-accent">{s.step}</span>
                  <div className="border-l border-border pl-5">
                    <h3 className="font-semibold text-foreground">{s.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {s.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <figure className="lg:sticky lg:top-24">
            <img
              src={memberImage}
              alt="A member standing outside the shop she financed"
              loading="lazy"
              width={1200}
              height={912}
              className="w-full rounded-lg border border-border object-cover"
            />
            <figcaption className="mt-4 border-l-2 border-accent pl-4 text-sm leading-relaxed text-muted-foreground">
              “I started with twenty thousand shillings of stock. Four cycles later
              I supply three other kiosks.”
              <span className="mt-2 block font-medium text-foreground">
                Grace W., member since 2021
              </span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
