import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface SpinnerLoaderProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "w-5 h-5",
  md: "w-8 h-8",
  lg: "w-12 h-12",
};

export function SpinnerLoader({ size = "md", className }: SpinnerLoaderProps) {
  return (
    <div className={cn("relative", sizeClasses[size], className)}>
      {/* Spinning gradient ring */}
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background: "conic-gradient(from 0deg, transparent, #3b82f6, #8b5cf6, transparent)",
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
      />
      {/* Inner circle to create ring effect */}
      <div 
        className="absolute rounded-full bg-background"
        style={{
          inset: "15%",
        }}
      />
    </div>
  );
}
