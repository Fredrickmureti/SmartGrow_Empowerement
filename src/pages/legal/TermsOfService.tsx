import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-12 sm:py-16">
        <div className="mb-8">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/"><ArrowLeft className="h-4 w-4 mr-2" />Back to Home</Link>
          </Button>
        </div>

        <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-2">Terms of Service</h1>
        <p className="text-muted-foreground mb-10">Last updated: February 26, 2026</p>

        <div className="prose prose-slate dark:prose-invert max-w-none space-y-8 text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>By accessing or using AccrualFlow ("the Platform"), you agree to be bound by these Terms of Service. If you are using the Platform on behalf of an organization, you represent that you have the authority to bind that organization to these terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">2. Description of Service</h2>
            <p>AccrualFlow is a cloud-based Enterprise Resource Planning (ERP) platform providing integrated modules for:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Accounting and financial management</li>
              <li>Human resources and payroll processing</li>
              <li>Inventory and warehouse management</li>
              <li>Point of Sale (POS) operations</li>
              <li>Sales, purchasing, and CRM</li>
              <li>Project management and timesheets</li>
              <li>Document management and electronic signatures</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">3. Account Responsibilities</h2>
            <p>You are responsible for:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Maintaining the confidentiality of your account credentials</li>
              <li>All activities that occur under your account</li>
              <li>Ensuring that all users in your organization comply with these terms</li>
              <li>Providing accurate and complete information during registration</li>
              <li>Promptly notifying us of any unauthorized access to your account</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">4. Subscription and Payment</h2>
            <p>Access to certain features requires a paid subscription. By subscribing, you agree to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Pay all fees associated with your selected plan</li>
              <li>Provide valid and current payment information</li>
              <li>Accept automatic renewal unless cancelled before the renewal date</li>
            </ul>
            <p>We reserve the right to modify pricing with 30 days' advance notice. Free trial periods, if offered, are subject to separate terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">5. Data Ownership</h2>
            <p>You retain full ownership of all data you enter into the Platform, including financial records, employee information, customer data, and transaction history. We do not claim ownership of your data and will not access it except as necessary to provide and improve our services or as required by law.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">6. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Use the Platform for any unlawful purpose or in violation of any applicable laws</li>
              <li>Attempt to gain unauthorized access to other accounts or system components</li>
              <li>Interfere with or disrupt the Platform's infrastructure or security</li>
              <li>Reverse engineer, decompile, or disassemble any part of the Platform</li>
              <li>Use the Platform to store or transmit malicious code</li>
              <li>Resell or redistribute access to the Platform without authorization</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">7. Service Availability</h2>
            <p>We strive to maintain high availability but do not guarantee uninterrupted access. We may perform scheduled maintenance with advance notice. We are not liable for downtime caused by factors beyond our reasonable control, including internet outages, third-party service failures, or force majeure events.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">8. Limitation of Liability</h2>
            <p>To the maximum extent permitted by law, AccrualFlow shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Platform. Our total liability shall not exceed the fees paid by you in the twelve (12) months preceding the claim.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">9. Termination</h2>
            <p>Either party may terminate the agreement at any time. Upon termination, you may request an export of your data within 30 days. After this period, we may delete your data in accordance with our retention policies. We reserve the right to suspend or terminate accounts that violate these terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">10. Governing Law</h2>
            <p>These terms shall be governed by and construed in accordance with applicable laws. Any disputes arising from these terms shall be resolved through binding arbitration or in the courts of the applicable jurisdiction.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">11. Changes to Terms</h2>
            <p>We reserve the right to modify these terms at any time. Material changes will be communicated via email or in-app notification at least 30 days before taking effect. Continued use after changes constitutes acceptance of the updated terms.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground">12. Contact</h2>
            <p>For questions about these Terms of Service, please visit <Link to="/contact" className="text-primary hover:underline">our contact page</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
