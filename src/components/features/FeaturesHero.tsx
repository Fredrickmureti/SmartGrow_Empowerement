import { motion } from "framer-motion";
import { Sparkles, CheckCircle2 } from "lucide-react";

const stats = [
  { value: "90+", label: "Features" },
  { value: "15", label: "Categories" },
  { value: "AI", label: "Powered" },
  { value: "24/7", label: "Support" },
];

export function FeaturesHero() {
  return (
    <section className="relative pt-32 pb-20 overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-accent/10 rounded-full blur-3xl" />
      </div>

      <div className="container mx-auto px-4 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-4xl mx-auto"
        >
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-8"
          >
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-muted-foreground">Complete Business Solution</span>
          </motion.div>

          {/* Title */}
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            <span className="text-foreground">Everything You Need to</span>
            <br />
            <span className="bg-gradient-to-r from-primary via-pink-500 to-accent text-transparent bg-clip-text">
              Run Your Business
            </span>
          </h1>

          {/* Subtitle */}
          <p className="text-lg md:text-xl text-muted-foreground mb-10 max-w-2xl mx-auto">
            From invoicing to inventory, accounting to AI insights — explore all the powerful 
            features that make AccrualFlow the complete solution for modern businesses.
          </p>

          {/* Quick Features */}
          <div className="flex flex-wrap justify-center gap-4 mb-12">
            {["Invoicing", "Spreadsheets", "e-Signatures", "POS", "CRM", "Projects", "Timesheets", "AI"].map((feature, i) => (
              <motion.div
                key={feature}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.1, duration: 0.5 }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-muted/50 border border-border"
              >
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-foreground/80">{feature}</span>
              </motion.div>
            ))}
          </div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.6 }}
            className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-2xl mx-auto"
          >
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="text-center p-4 rounded-xl bg-muted/50 border border-border"
              >
                <div className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-primary to-accent text-transparent bg-clip-text">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
              </div>
            ))}
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
