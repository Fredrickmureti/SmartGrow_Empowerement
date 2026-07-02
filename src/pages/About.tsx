import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { 
  ArrowLeft, 
  FileText, 
  Target, 
  Heart, 
  Zap, 
  Shield, 
  Users,
  Globe,
  TrendingUp,
  Award
} from "lucide-react";
import { useState } from "react";
import { ScheduleDemoDialog } from "@/components/landing/ScheduleDemoDialog";

const values = [
  {
    icon: Heart,
    title: "Customer First",
    description: "Every feature we build starts with understanding our customers' real challenges and needs."
  },
  {
    icon: Zap,
    title: "Simplicity",
    description: "We believe powerful software doesn't have to be complicated. We strive for elegant solutions."
  },
  {
    icon: Shield,
    title: "Trust & Security",
    description: "Your financial data deserves the highest level of protection. Security is non-negotiable."
  },
  {
    icon: TrendingUp,
    title: "Continuous Improvement",
    description: "We're never done. We constantly iterate and improve based on feedback and new possibilities."
  }
];

const stats = [
  { value: "1,000+", label: "Businesses Served" },
  { value: "20K", label: "Invoices Processed" },
  { value: "99.9%", label: "Uptime" }
];

export default function About() {
  const [showDemoDialog, setShowDemoDialog] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <Button variant="outline" asChild>
              <Link to="/login">Sign In</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 bg-gradient-to-br from-purple-600 via-purple-700 to-cyan-600 text-white">
        <div className="container mx-auto px-4 text-center">
          <div className="flex justify-center mb-6">
            <div className="h-16 w-16 rounded-2xl bg-white/20 flex items-center justify-center">
              <FileText className="h-8 w-8" />
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-6">About AccrualFlow</h1>
          <p className="text-xl text-white/80 max-w-2xl mx-auto">
            We're on a mission to make financial management accessible, 
            intuitive, and powerful for businesses of all sizes.
          </p>
        </div>
      </section>

      {/* Mission */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center">
            <Target className="h-12 w-12 text-primary mx-auto mb-6" />
            <h2 className="text-3xl font-bold mb-6">Our Mission</h2>
            <p className="text-lg text-muted-foreground mb-8">
              AccrualFlow was born from a simple observation: most accounting and invoicing 
              software is either too complex for small businesses or too limited for growing ones. 
              We set out to build something different — a platform that grows with you, 
              from your first invoice to enterprise-scale operations.
            </p>
            <p className="text-lg text-muted-foreground">
              Today, we serve thousands of businesses across the globe, from freelancers and 
              startups to established enterprises. Our platform processes billions in transactions 
              annually, helping businesses get paid faster, track expenses smarter, and make 
              better financial decisions.
            </p>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-16 bg-muted/50">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <div key={index} className="text-center">
                <div className="text-4xl font-bold text-primary mb-2">{stat.value}</div>
                <div className="text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Our Values</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              These principles guide everything we do, from product decisions to customer interactions.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {values.map((value, index) => (
              <Card key={index}>
                <CardContent className="pt-6">
                  <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                    <value.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">{value.title}</h3>
                  <p className="text-sm text-muted-foreground">{value.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Why AccrualFlow */}
      <section className="py-20 bg-muted/50">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <Award className="h-12 w-12 text-primary mx-auto mb-4" />
              <h2 className="text-3xl font-bold mb-4">Why Choose AccrualFlow?</h2>
            </div>
            <div className="grid md:grid-cols-2 gap-8">
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Built for Global Business</h3>
                    <p className="text-sm text-muted-foreground">
                      Multi-currency support, localized tax handling, and compliance 
                      with international standards.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Team Collaboration</h3>
                    <p className="text-sm text-muted-foreground">
                      Invite unlimited team members with role-based permissions. 
                      Everyone sees what they need, nothing more.
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Shield className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Enterprise Security</h3>
                    <p className="text-sm text-muted-foreground">
                      Bank-level encryption, regular security audits, and compliance 
                      with data protection regulations.
                    </p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Zap className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">Lightning Fast</h3>
                    <p className="text-sm text-muted-foreground">
                      Optimized for speed. Create invoices in seconds, generate 
                      reports instantly, and never wait for your data.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
          <p className="text-muted-foreground mb-8 max-w-xl mx-auto">
            Join thousands of businesses that trust AccrualFlow for their financial management.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" asChild>
              <Link to="/signup">Start Free Trial</Link>
            </Button>
            <Button size="lg" variant="outline" onClick={() => setShowDemoDialog(true)}>
              Schedule a Demo
            </Button>
          </div>
        </div>
      </section>

      <ScheduleDemoDialog 
        open={showDemoDialog} 
        onOpenChange={setShowDemoDialog} 
      />
    </div>
  );
}
