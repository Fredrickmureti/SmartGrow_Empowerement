import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Building2, FileText, Sparkles, Loader2, LayoutGrid, Home, Users } from "lucide-react";

interface SetupStep {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface WorkspaceSetupScreenProps {
  businessName: string;
  currentStep: number;
  totalSteps: number;
  isComplete: boolean;
  onComplete?: () => void;
}

const setupSteps: SetupStep[] = [
  { id: "organization", label: "Creating your organization", icon: <Building2 className="h-5 w-5" /> },
  { id: "accounts", label: "Setting up chart of accounts", icon: <FileText className="h-5 w-5" /> },
  { id: "apps", label: "Installing your apps", icon: <LayoutGrid className="h-5 w-5" /> },
  { id: "team", label: "Sending team invitations", icon: <Users className="h-5 w-5" /> },
  { id: "ready", label: "Preparing your workspace", icon: <Home className="h-5 w-5" /> },
];

export function WorkspaceSetupScreen({
  businessName,
  currentStep,
  totalSteps,
  isComplete,
  onComplete,
}: WorkspaceSetupScreenProps) {
  const [displayStep, setDisplayStep] = useState(0);

  // Animate through steps with slight delay
  useEffect(() => {
    if (currentStep > displayStep) {
      const timer = setTimeout(() => {
        setDisplayStep(currentStep);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [currentStep, displayStep]);

  // Auto-complete callback
  useEffect(() => {
    if (isComplete && onComplete) {
      const timer = setTimeout(onComplete, 1500);
      return () => clearTimeout(timer);
    }
  }, [isComplete, onComplete]);

  const completedSteps = isComplete ? totalSteps : Math.min(displayStep + 1, totalSteps);
  const progress = Math.min((completedSteps / totalSteps) * 100, 100);

  const effectiveStep = isComplete ? totalSteps : displayStep;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-lg"
      >
        {/* Logo & Header */}
        <div className="text-center mb-8">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", delay: 0.2 }}
            className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6"
          >
            <Building2 className="w-10 h-10 text-primary" />
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-2xl font-bold mb-2"
          >
            Setting up {businessName}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-muted-foreground"
          >
            We're preparing your workspace. This will only take a moment.
          </motion.p>
        </div>

        {/* Progress Bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="mb-8"
        >
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-primary rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>
          <div className="flex justify-between mt-2 text-sm text-muted-foreground">
            <span>Setting up...</span>
            <span>{Math.round(progress)}%</span>
          </div>
        </motion.div>

        {/* Setup Steps */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="bg-card border rounded-xl p-6 space-y-4"
        >
          {setupSteps.map((step, index) => {
            const isStepComplete = index < effectiveStep;
            const isStepCurrent = index === effectiveStep;
            const isStepPending = index > effectiveStep;

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.7 + index * 0.1 }}
                className={`flex items-center gap-4 p-3 rounded-lg transition-colors ${
                  isStepComplete
                    ? "bg-success/10"
                    : isStepCurrent
                    ? "bg-primary/10"
                    : "bg-muted/30"
                }`}
              >
                {/* Step Icon */}
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                    isStepComplete
                      ? "bg-success text-success-foreground"
                      : isStepCurrent
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  <AnimatePresence mode="wait">
                    {isStepComplete ? (
                      <motion.div
                        key="check"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0 }}
                        transition={{ type: "spring", duration: 0.3 }}
                      >
                        <Check className="h-5 w-5" />
                      </motion.div>
                    ) : isStepCurrent ? (
                      <motion.div
                        key="loading"
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                      >
                        <Loader2 className="h-5 w-5" />
                      </motion.div>
                    ) : (
                      <motion.div key="icon">{step.icon}</motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Step Label */}
                <div className="flex-1">
                  <p
                    className={`font-medium ${
                      isStepComplete
                        ? "text-success"
                        : isStepCurrent
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </p>
                  {isStepComplete && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-sm text-success"
                    >
                      Complete
                    </motion.p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Complete State */}
        <AnimatePresence>
          {isComplete && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.5 }}
              className="mt-8 text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.7 }}
                className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4"
              >
                <Check className="w-8 h-8 text-success" />
              </motion.div>
              <h2 className="text-xl font-semibold mb-2">You're all set!</h2>
              <p className="text-muted-foreground">
                Taking you to your apps...
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
