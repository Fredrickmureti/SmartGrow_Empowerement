import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LedgerShowcase } from "./LedgerShowcase";
interface AuthLayoutProps {
  children: ReactNode;
  title: string;
  subtitle?: string;
  description?: string;
}
export function AuthLayout({
  children,
  title,
  subtitle,
  description
}: AuthLayoutProps) {
  return <div className="min-h-screen flex">
      {/* Left Panel - Branding */}
      <div className="hidden lg:flex lg:w-1/2 bg-primary relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary to-accent opacity-90" />
        <div className="relative z-10 flex flex-col justify-center px-12 text-primary-foreground">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-primary-foreground/20 flex items-center justify-center">
                <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                  <path d="M8 7h6" />
                  <path d="M8 11h8" />
                </svg>
              </div>
              <Link to="/" className="text-2xl font-bold hover:opacity-80 transition-opacity">Smart Grow Empowerment</Link>
            </div>
            <h1 className="text-4xl font-bold mb-3 leading-tight">
              Every transaction,
              <br />
              posted and balanced.
            </h1>
            <p className="text-base text-primary-foreground/75 max-w-md">
              Invoicing, inventory, payroll and point of sale — all landing in one
              double-entry general ledger, in real time.
            </p>
          </div>

          <LedgerShowcase />
        </div>

        {/* Decorative elements */}
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary-foreground/5 rounded-full blur-3xl" />
        <div className="absolute top-20 right-20 w-64 h-64 bg-accent/20 rounded-full blur-3xl" />
      </div>

      {/* Right Panel - Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 bg-background">
        <div className="w-full max-w-md animate-fade-in">
          <div className="lg:hidden mb-8 text-center">
            <div className="flex items-center justify-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
                <svg className="w-6 h-6 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                  <path d="M8 7h6" />
                  <path d="M8 11h8" />
                </svg>
              </div>
              <Link to="/" className="text-xl font-bold text-foreground hover:opacity-80 transition-opacity">Smart Grow Empowerment</Link>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-foreground">{title}</h2>
            {(subtitle || description) && <p className="text-muted-foreground mt-2">{subtitle || description}</p>}
          </div>

          {children}
        </div>
      </div>
    </div>;
}