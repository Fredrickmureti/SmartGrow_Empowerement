import React from "react";
import { Button, ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";
import { Crown, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

interface SubscriptionActionButtonProps extends Omit<ButtonProps, "onClick"> {
  feature: string;
  children: React.ReactNode;
  onClick?: () => void;
  showLockIcon?: boolean;
  tooltipText?: string;
}

export function SubscriptionActionButton({
  feature,
  children,
  onClick,
  showLockIcon = true,
  tooltipText,
  className,
  disabled,
  ...props
}: SubscriptionActionButtonProps) {
  const { hasAccess, requiredPlan, openUpgradeModal } = useFeatureAccess(feature);
  const { isReadOnly } = useSubscriptionAccess();

  const isLocked = !hasAccess || isReadOnly;
  
  const handleClick = () => {
    if (isLocked) {
      openUpgradeModal();
    } else {
      onClick?.();
    }
  };

  const button = (
    <Button
      {...props}
      className={cn(
        className,
        isLocked && "relative"
      )}
      disabled={disabled}
      onClick={handleClick}
    >
      {children}
      {isLocked && showLockIcon && (
        <Crown className="ml-1.5 h-3.5 w-3.5 text-amber-500" />
      )}
    </Button>
  );

  if (isLocked && tooltipText !== "") {
    const defaultTooltip = requiredPlan 
      ? `Requires ${requiredPlan} plan` 
      : "Upgrade to unlock";
    
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {button}
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText || defaultTooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

// A variant for icon-only buttons
interface SubscriptionActionIconButtonProps extends Omit<ButtonProps, "onClick"> {
  feature: string;
  children: React.ReactNode;
  onClick?: () => void;
  tooltipText?: string;
}

export function SubscriptionActionIconButton({
  feature,
  children,
  onClick,
  tooltipText,
  className,
  disabled,
  ...props
}: SubscriptionActionIconButtonProps) {
  const { hasAccess, requiredPlan, openUpgradeModal } = useFeatureAccess(feature);
  const { isReadOnly } = useSubscriptionAccess();

  const isLocked = !hasAccess || isReadOnly;
  
  const handleClick = () => {
    if (isLocked) {
      openUpgradeModal();
    } else {
      onClick?.();
    }
  };

  const defaultTooltip = isLocked
    ? (requiredPlan ? `Requires ${requiredPlan} plan` : "Upgrade to unlock")
    : tooltipText;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          variant={props.variant || "ghost"}
          size={props.size || "icon"}
          className={cn(className, isLocked && "opacity-70")}
          disabled={disabled}
          onClick={handleClick}
        >
          {isLocked ? (
            <Lock className="h-4 w-4 text-amber-500" />
          ) : (
            children
          )}
        </Button>
      </TooltipTrigger>
      {defaultTooltip && (
        <TooltipContent>
          <p>{defaultTooltip}</p>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
