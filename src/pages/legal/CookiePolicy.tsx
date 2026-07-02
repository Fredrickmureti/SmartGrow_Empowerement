import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function CookiePolicy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12 sm:py-16">
        <div className="mb-8">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/"><ArrowLeft className="h-4 w-4 mr-2" />Back to Home</Link>
          </Button>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-2">Cookie Policy</h1>
        <p className="text-muted-foreground mb-10">Last updated: February 26, 2026</p>

        <div className="prose prose-slate dark:prose-invert max-w-none space-y-8 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">1. What Are Cookies</h2>
            <p>Cookies are small text files stored on your device when you visit a website. They help the website remember your preferences and improve your browsing experience. AccrualFlow uses cookies and similar technologies to provide, secure, and improve our platform.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">2. Types of Cookies We Use</h2>

            <h3 className="text-lg font-medium text-foreground mt-4">Essential Cookies</h3>
            <p>These cookies are strictly necessary for the Platform to function. They include:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Authentication tokens</strong> — Keep you signed in securely across sessions</li>
              <li><strong>Session cookies</strong> — Maintain your active session and organization context</li>
              <li><strong>CSRF protection</strong> — Prevent cross-site request forgery attacks</li>
              <li><strong>Sidebar state</strong> — Remember your navigation panel preferences</li>
            </ul>
            <p>These cookies cannot be disabled as the Platform will not function without them.</p>

            <h3 className="text-lg font-medium text-foreground mt-4">Functional Cookies</h3>
            <p>These cookies enhance your experience by remembering your preferences:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Theme preference</strong> — Light mode, dark mode, or system preference</li>
              <li><strong>Language and locale</strong> — Your preferred display language and date/number formatting</li>
              <li><strong>View preferences</strong> — Grid vs. list views, table column configurations</li>
              <li><strong>Last active organization/business</strong> — Restore your workspace on return visits</li>
            </ul>

            <h3 className="text-lg font-medium text-foreground mt-4">Analytics Cookies</h3>
            <p>We may use analytics cookies to understand how users interact with the Platform. This data is anonymized and used solely to improve our services. We do not use third-party advertising trackers.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">3. Local Storage</h2>
            <p>In addition to cookies, we use browser local storage for:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Offline data caching for the POS module</li>
              <li>Draft form data to prevent accidental loss</li>
              <li>User interface state and preferences</li>
              <li>PWA (Progressive Web App) service worker data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">4. Third-Party Cookies</h2>
            <p>We minimize the use of third-party cookies. Any third-party services integrated into the Platform (such as payment processors or error tracking tools) may set their own cookies subject to their respective privacy policies. We do not allow third-party advertising cookies on our Platform.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">5. Managing Cookies</h2>
            <p>You can manage cookies through your browser settings. Most browsers allow you to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>View and delete existing cookies</li>
              <li>Block all or certain types of cookies</li>
              <li>Set preferences for specific websites</li>
            </ul>
            <p>Please note that blocking essential cookies will prevent you from using the Platform. Blocking functional cookies may degrade your experience.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">6. Data Retention for Cookies</h2>
            <p>Session cookies are deleted when you close your browser. Persistent cookies (such as authentication tokens and preferences) are retained for up to 12 months or until you sign out, whichever comes first. Analytics cookies are retained for a maximum of 24 months.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">7. Changes to This Policy</h2>
            <p>We may update this Cookie Policy as our services evolve. Changes will be reflected on this page with an updated "Last updated" date.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">8. Contact</h2>
            <p>If you have questions about our use of cookies, please visit <Link to="/contact" className="text-primary hover:underline">our contact page</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
