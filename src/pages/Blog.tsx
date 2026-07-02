import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, BookOpen, Bell } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { toast } from "sonner";

export default function Blog() {
  const [email, setEmail] = useState("");

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    toast.success(`Thanks for subscribing with ${email}! We'll notify you when we launch.`);
    setEmail("");
  };

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

      {/* Coming Soon */}
      <section className="flex items-center justify-center py-32">
        <div className="container mx-auto px-4 text-center max-w-lg">
          <div className="inline-flex items-center justify-center h-20 w-20 rounded-full bg-primary/10 mb-8">
            <BookOpen className="h-10 w-10 text-primary" />
          </div>
          <h1 className="text-4xl font-bold mb-4">Blog Coming Soon</h1>
          <p className="text-lg text-muted-foreground mb-10">
            We're working on insightful articles about business finance, tips, and product updates. Stay tuned!
          </p>

          <div className="bg-muted/50 rounded-xl p-8">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Bell className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Get notified when we launch</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-5">
              Subscribe and be the first to read our content.
            </p>
            <form onSubmit={handleSubscribe} className="flex gap-2">
              <Input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="flex-1"
              />
              <Button type="submit">Notify Me</Button>
            </form>
            <p className="text-xs text-muted-foreground mt-3">
              No spam, unsubscribe anytime.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
