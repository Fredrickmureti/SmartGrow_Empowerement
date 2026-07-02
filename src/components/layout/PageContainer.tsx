/**
 * PageContainer Component
 * 
 * Provides consistent max-width container with responsive padding
 * for professional content layout within app workspaces.
 */

import { ReactNode } from "react";
import { cn } from "@/lib/utils";

const maxWidthClasses = {
  sm: "max-w-2xl",
  md: "max-w-4xl",
  lg: "max-w-5xl",
  xl: "max-w-6xl",
  "2xl": "max-w-7xl",
  "7xl": "max-w-7xl",
  full: "max-w-full",
} as const;

interface PageContainerProps {
  children: ReactNode;
  /** Maximum width constraint */
  maxWidth?: keyof typeof maxWidthClasses;
  /** Additional class names */
  className?: string;
  /** Whether to add default padding */
  noPadding?: boolean;
}

export function PageContainer({
  children,
  maxWidth = "7xl",
  className,
  noPadding = false,
}: PageContainerProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full",
        maxWidthClasses[maxWidth],
        !noPadding && "px-4 sm:px-6 lg:px-8",
        className
      )}
    >
      {children}
    </div>
  );
}
