import { useRef, useState } from "react";
import { motion, useInView } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, FileText, Calendar } from "lucide-react";
import { ScheduleDemoDialog } from "./ScheduleDemoDialog";
import { useAuth } from "@/contexts/AuthContext";

export function CTASection() {
  const ref = useRef<HTMLDivElement>(null);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const { user } = useAuth();
  const isInView = useInView(ref, {
    once: true,
    margin: "-100px"
  });
  return (
    <>
      <section ref={ref} className="py-24 relative overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-purple-600 via-purple-700 to-cyan-600" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:50px_50px]" />
        
        {/* Decorative elements */}
        <div className="absolute top-0 left-0 w-96 h-96 bg-white/10 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-96 h-96 bg-cyan-400/20 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />

        <div className="container mx-auto px-4 relative z-10">
          <motion.div initial={{
            opacity: 0,
            y: 30
          }} animate={isInView ? {
            opacity: 1,
            y: 0
          } : {}} transition={{
            duration: 0.6
          }} className="max-w-3xl mx-auto text-center">
            <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-6">
              Ready to Take Control of Your Finances?
            </h2>
            <p className="text-lg md:text-xl text-white/80 mb-10">
              Join thousands of businesses that trust AccrualFlow for their invoicing and accounting needs. 
              Start your free trial today — no credit card required.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" className="bg-white text-purple-700 hover:bg-white/90 px-8" asChild>
                <Link to={user ? "/dashboard" : "/signup"}>
                  {user ? "Go to Dashboard" : "Start Free Trial"}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button 
                size="lg" 
                variant="outline" 
                className="border-white/50 text-foreground bg-white/90 hover:bg-white dark:text-white dark:bg-transparent dark:border-white/30 dark:hover:bg-white/10"
                onClick={() => setShowScheduleDialog(true)}
              >
                <Calendar className="mr-2 h-5 w-5" />
                Schedule a Demo
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
      
      <ScheduleDemoDialog 
        open={showScheduleDialog} 
        onOpenChange={setShowScheduleDialog} 
      />
    </>
  );
}

export function FooterSection() {
  const currentYear = new Date().getFullYear();
  const [showContactDialog, setShowContactDialog] = useState(false);

  return (
    <>
      <footer className="bg-slate-900 text-white py-16">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-12 mb-12">
            {/* Brand */}
            <div className="lg:col-span-2">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center">
                  <FileText className="h-6 w-6 text-white" />
                </div>
                <span className="text-2xl font-bold">AccrualFlow</span>
              </div>
              <p className="text-slate-400 max-w-sm">
                The all-in-one invoicing and accounting platform for modern businesses. 
                Simplify your finances and focus on what matters most — growing your business.
              </p>
            </div>

            {/* Product Links */}
            <div>
              <h4 className="font-semibold mb-4">Product</h4>
              <ul className="space-y-3 text-slate-400">
                <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Integrations</a></li>
              </ul>
            </div>

            {/* Company Links */}
            <div>
              <h4 className="font-semibold mb-4">Company</h4>
              <ul className="space-y-3 text-slate-400">
                <li><Link to="/about" className="hover:text-white transition-colors">About</Link></li>
                <li><Link to="/blog" className="hover:text-white transition-colors">Blog</Link></li>
                <li>
                  <button 
                    onClick={() => setShowContactDialog(true)}
                    className="hover:text-white transition-colors"
                  >
                    Contact
                  </button>
                </li>
              </ul>
            </div>

            {/* Support Links */}
            <div>
              <h4 className="font-semibold mb-4">Support</h4>
              <ul className="space-y-3 text-slate-400">
                <li><Link to="/help" className="hover:text-white transition-colors">Help Center</Link></li>
                <li><Link to="/docs" className="hover:text-white transition-colors">Documentation</Link></li>
              </ul>
            </div>
          </div>

          {/* Bottom */}
          <div className="border-t border-slate-800 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-slate-400 text-sm">
              © {currentYear} AccrualFlow. All rights reserved.
            </p>
            <div className="flex gap-6 text-slate-400 text-sm">
              <a href="/privacy" className="hover:text-white transition-colors">Privacy Policy</a>
              <a href="/terms" className="hover:text-white transition-colors">Terms of Service</a>
              <a href="/cookies" className="hover:text-white transition-colors">Cookie Policy</a>
            </div>
          </div>
        </div>
      </footer>
      
      <ScheduleDemoDialog 
        open={showContactDialog} 
        onOpenChange={setShowContactDialog} 
      />
    </>
  );
}