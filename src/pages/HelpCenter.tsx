import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Search, 
  FileText, 
  CreditCard, 
  Building2, 
  ShoppingCart, 
  BarChart3, 
  Settings,
  ArrowLeft,
  MessageCircle
} from "lucide-react";
import { ScheduleDemoDialog } from "@/components/landing/ScheduleDemoDialog";

const helpCategories = [
  {
    id: "getting-started",
    title: "Getting Started",
    icon: FileText,
    faqs: [
      {
        question: "How do I create my first invoice?",
        answer: "Navigate to Invoices from the sidebar, click 'New Invoice', fill in your customer details, add line items, and click 'Create Invoice'. You can then send it directly via email or download as PDF."
      },
      {
        question: "How do I set up my business profile?",
        answer: "Go to Settings > Business Settings to add your company name, logo, address, tax information, and default invoice preferences. This information will appear on all your invoices and documents."
      },
      {
        question: "Can I invite team members?",
        answer: "Yes! Go to Team from the sidebar to invite team members via email. You can assign roles like Admin, Manager, or Accountant with different permission levels."
      }
    ]
  },
  {
    id: "invoicing",
    title: "Invoicing & Billing",
    icon: CreditCard,
    faqs: [
      {
        question: "How do recurring invoices work?",
        answer: "Set up recurring invoices to automatically generate and send invoices on a schedule (weekly, monthly, yearly). Go to Recurring Invoices, create a template, set the frequency, and the system handles the rest."
      },
      {
        question: "How do I record a payment?",
        answer: "Open any invoice and click 'Record Payment'. Enter the amount received, payment method, and date. Partial payments are supported and the invoice status will update automatically."
      },
      {
        question: "Can I create estimates/quotes?",
        answer: "Yes! Use the Estimates feature to create quotes for your customers. Once approved, you can convert an estimate to an invoice with one click."
      }
    ]
  },
  {
    id: "expenses",
    title: "Expenses & Purchases",
    icon: Building2,
    faqs: [
      {
        question: "How do I track expenses?",
        answer: "Go to Expenses to add new expenses. You can categorize them, attach receipts, and link them to specific accounts for accurate reporting."
      },
      {
        question: "What are Bills vs Expenses?",
        answer: "Bills are payables to vendors that you'll pay later (accounts payable). Expenses are immediate payments. Use Bills when you need to track what you owe before paying."
      },
      {
        question: "How do I upload receipts?",
        answer: "When creating an expense, click the receipt upload area to attach images or PDFs. You can also drag and drop files directly."
      }
    ]
  },
  {
    id: "banking",
    title: "Banking & Reconciliation",
    icon: Building2,
    faqs: [
      {
        question: "How do I add a bank account?",
        answer: "Go to Banking > Bank Accounts and click 'Add Bank Account'. You can set up a manual account and import statements (CSV, Excel, OFX, QBO, QIF), or connect to a supported bank for automatic syncing."
      },
      {
        question: "What is bank reconciliation?",
        answer: "Reconciliation matches your bank transactions with your accounting records. Go to Bank Reconciliation to match transactions, categorize them, and ensure your books are accurate."
      },
      {
        question: "Can I set up automatic categorization?",
        answer: "Yes! Use Transaction Rules to automatically categorize recurring transactions based on description, amount, or other criteria."
      }
    ]
  },
  {
    id: "pos",
    title: "POS System",
    icon: ShoppingCart,
    faqs: [
      {
        question: "How do I set up a POS register?",
        answer: "Go to POS > Settings to create registers. Each register can have its own settings, receipt printer, and cash drawer. Staff can log into registers using their credentials."
      },
      {
        question: "Does POS work offline?",
        answer: "Yes! AccrualFlow POS works offline. Transactions are stored locally and automatically sync when you're back online. Perfect for areas with unreliable internet."
      },
      {
        question: "How do shifts work?",
        answer: "Open a shift to start accepting transactions. At the end, close the shift to reconcile cash, view sales summary, and generate shift reports."
      }
    ]
  },
  {
    id: "reports",
    title: "Reports & Analytics",
    icon: BarChart3,
    faqs: [
      {
        question: "What reports are available?",
        answer: "We offer Financial Reports (P&L, Balance Sheet), Sales Reports, Tax Reports, Stock Reports, and Management Reports. Each can be filtered by date range and exported."
      },
      {
        question: "How do I export reports?",
        answer: "Open any report and click the Export button. Choose from PDF, Excel, or CSV formats. Reports include your company branding."
      },
      {
        question: "Can I schedule automated reports?",
        answer: "Yes! Go to Studio > Scheduling to set up automated reports. You can schedule daily, weekly, monthly, or quarterly reports to be automatically generated and emailed to specified recipients in PDF, CSV, or Excel format."
      }
    ]
  },
  {
    id: "settings",
    title: "Account & Settings",
    icon: Settings,
    faqs: [
      {
        question: "How do I change my password?",
        answer: "Go to Settings > Account to change your password. You can also enable two-factor authentication for additional security."
      },
      {
        question: "How do I set up tax rates?",
        answer: "Go to Settings > Tax Rates to configure your tax rates. You can set default rates for products and override them per invoice line item."
      },
      {
        question: "Can I customize invoice templates?",
        answer: "Yes! Go to Settings > Invoice Settings to customize colors, add terms and conditions, set payment instructions, and configure your default settings."
      }
    ]
  }
];

export default function HelpCenter() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showContactDialog, setShowContactDialog] = useState(false);

  const filteredCategories = helpCategories.map(category => ({
    ...category,
    faqs: category.faqs.filter(
      faq => 
        faq.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
        faq.answer.toLowerCase().includes(searchQuery.toLowerCase())
    )
  })).filter(category => category.faqs.length > 0 || !searchQuery);

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
      <section className="bg-gradient-to-br from-purple-600 via-purple-700 to-cyan-600 text-white py-16">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl font-bold mb-4">How can we help you?</h1>
          <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
            Search our help center or browse categories below to find answers to your questions.
          </p>
          <div className="max-w-xl mx-auto relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              placeholder="Search for help..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-12 h-12 text-foreground"
            />
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          {searchQuery && (
            <p className="text-muted-foreground mb-8">
              Showing results for "{searchQuery}"
            </p>
          )}
          
          <div className="grid md:grid-cols-2 gap-8">
            {filteredCategories.map((category) => (
              <Card key={category.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <category.icon className="h-5 w-5 text-primary" />
                    </div>
                    {category.title}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Accordion type="single" collapsible>
                    {category.faqs.map((faq, index) => (
                      <AccordionItem key={index} value={`${category.id}-${index}`}>
                        <AccordionTrigger className="text-left">
                          {faq.question}
                        </AccordionTrigger>
                        <AccordionContent className="text-muted-foreground">
                          {faq.answer}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </CardContent>
              </Card>
            ))}
          </div>

          {filteredCategories.length === 0 && (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-4">No results found for "{searchQuery}"</p>
              <Button variant="outline" onClick={() => setSearchQuery("")}>
                Clear search
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Contact CTA */}
      <section className="py-16 bg-muted/50">
        <div className="container mx-auto px-4 text-center">
          <MessageCircle className="h-12 w-12 text-primary mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-2">Still need help?</h2>
          <p className="text-muted-foreground mb-6">
            Can't find what you're looking for? Our team is here to help.
          </p>
          <Button onClick={() => setShowContactDialog(true)}>
            Contact Support
          </Button>
        </div>
      </section>

      <ScheduleDemoDialog 
        open={showContactDialog} 
        onOpenChange={setShowContactDialog} 
      />
    </div>
  );
}
