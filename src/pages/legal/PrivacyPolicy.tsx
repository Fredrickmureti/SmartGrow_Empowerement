import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12 sm:py-16">
        <div className="mb-8">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/"><ArrowLeft className="h-4 w-4 mr-2" />Back to Home</Link>
          </Button>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-2">Privacy Policy</h1>
        <p className="text-muted-foreground mb-10">Last updated: February 26, 2026</p>

        <div className="prose prose-slate dark:prose-invert max-w-none space-y-8 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">1. Information We Collect</h2>
            <p>We collect information you provide directly when you create an account, set up your organization, or use our services. This includes:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Account information (name, email address, password)</li>
              <li>Organization and business details (company name, address, tax identifiers)</li>
              <li>Financial data you enter into the system (invoices, transactions, payroll records)</li>
              <li>Employee data managed through the HR module</li>
              <li>Usage data and interaction logs for improving our services</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">2. How We Use Your Information</h2>
            <p>We use the collected information to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Provide, maintain, and improve our ERP platform and services</li>
              <li>Process transactions and manage your accounting, HR, and inventory data</li>
              <li>Send important service notifications and updates</li>
              <li>Provide customer support and respond to your inquiries</li>
              <li>Ensure security, detect fraud, and prevent unauthorized access</li>
              <li>Generate anonymized analytics to improve platform performance</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">3. Data Storage and Security</h2>
            <p>Your data is stored securely using industry-standard encryption at rest and in transit. We use Supabase infrastructure with row-level security (RLS) policies to ensure strict multi-tenant data isolation. Each organization's data is logically separated and accessible only to authorized users within that organization.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">4. Data Sharing</h2>
            <p>We do not sell, trade, or rent your personal or business data to third parties. We may share information only in the following circumstances:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>With your explicit consent</li>
              <li>With service providers who assist in operating our platform (under strict confidentiality agreements)</li>
              <li>When required by law, regulation, or legal process</li>
              <li>To protect the rights, safety, and property of our users and our company</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">5. Data Retention</h2>
            <p>We retain your data for as long as your account is active or as needed to provide services. Financial and payroll records may be retained longer to comply with applicable legal and regulatory requirements. You can request data export or deletion by contacting our support team.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">6. Your Rights</h2>
            <p>Depending on your jurisdiction, you may have the right to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Access, correct, or delete your personal data</li>
              <li>Export your data in a machine-readable format</li>
              <li>Withdraw consent for optional data processing</li>
              <li>Object to or restrict certain data processing activities</li>
              <li>Lodge a complaint with your local data protection authority</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">7. Children's Privacy</h2>
            <p>Our services are designed for business use and are not intended for individuals under the age of 18. We do not knowingly collect personal information from children.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">8. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. We will notify you of significant changes by posting the updated policy on our platform and updating the "Last updated" date. Continued use of our services after changes constitutes acceptance of the revised policy.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">9. Contact Us</h2>
            <p>If you have questions about this Privacy Policy or your data, please contact us at <Link to="/contact" className="text-primary hover:underline">our contact page</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
