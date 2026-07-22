/**
 * TransactionActionMenu — Stage 3 of the POS refund/reversal remediation.
 *
 * Replaces the single-purpose "Void" button in the Transaction History
 * detail panel with the six-command taxonomy from Stage 2, each entry
 * gated by `evaluateEligibility()`. Ineligible commands are rendered as
 * disabled entries with the machine reason exposed in a tooltip so
 * cashiers understand WHY a reversal is unavailable — the audit found
 * that today ineligible actions are simply hidden, which drives
 * "reverse-by-refund-and-hope" workarounds.
 *
 * Dispatch mapping:
 *   - void_sale                  → onVoid()          (same-shift, pre-fulfilment)
 *   - reverse_card_authorization → onReverseCard()   (card FSM in details panel)
 *   - return_goods               → onReturn()        (opens return workspace)
 *   - exchange                   → onExchange()      (return workspace w/ new sale)
 *   - refund_sale                → onRefund()        (cash-out on completed sale)
 *   - issue_store_credit         → onStoreCredit()   (credit note against customer)
 *
 * The handlers themselves live at the callsite — this component only
 * renders the menu and applies eligibility gates so the routing table
 * is uniform across every history surface. See Stage 2 eligibility
 * rules in `src/services/pos/reversal/eligibility.ts`.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Ban,
  RotateCcw,
  Undo2,
  Repeat,
  Receipt,
  Wallet,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateEligibility,
  type EligibilityFacts,
  type EligibilityResult,
} from "@/services/pos/reversal/eligibility";
import type { POSReversalCommandType } from "@/services/pos/reversal/reasonCodes";

const INELIGIBILITY_COPY: Record<
  NonNullable<EligibilityResult["ineligibilityReason"]>,
  string
> = {
  sale_not_completed:
    "Only completed sales can use this action.",
  sale_already_reversed:
    "This sale has already been reversed.",
  not_on_current_shift:
    "Void is only allowed on the current shift. Use Refund or Return.",
  goods_already_fulfilled:
    "Goods have already left inventory. Use Return goods instead.",
  no_authorized_card_tender:
    "No authorized card tender is available to reverse.",
  no_settled_tender:
    "Nothing has settled yet — nothing to refund.",
  no_returnable_lines:
    "This sale has no line items eligible for return.",
  no_identified_customer:
    "Store credit requires a known customer on the sale.",
};

const COMMAND_META: Record<
  POSReversalCommandType,
  { label: string; description: string; icon: React.ComponentType<{ className?: string }>; destructive?: boolean }
> = {
  void_sale: {
    label: "Void sale",
    description: "Same-shift cancellation before goods leave inventory",
    icon: Ban,
    destructive: true,
  },
  reverse_card_authorization: {
    label: "Reverse card authorization",
    description: "Release the card hold before it settles",
    icon: Undo2,
  },
  refund_sale: {
    label: "Refund sale",
    description: "Return cash to the customer after settlement",
    icon: RotateCcw,
    destructive: true,
  },
  return_goods: {
    label: "Return goods",
    description: "Take items back into inventory",
    icon: Receipt,
  },
  exchange: {
    label: "Exchange",
    description: "Swap returned items for a new sale",
    icon: Repeat,
  },
  issue_store_credit: {
    label: "Issue store credit",
    description: "Convert the refund into a credit note",
    icon: Wallet,
  },
};

export interface TransactionActionHandlers {
  onVoid: () => void;
  onReverseCard: () => void;
  onRefund: () => void;
  onReturn: () => void;
  onExchange: () => void;
  onStoreCredit: () => void;
}

export interface TransactionActionMenuProps {
  facts: EligibilityFacts;
  handlers: TransactionActionHandlers;
  disabled?: boolean;
  className?: string;
  triggerLabel?: string;
}

export function TransactionActionMenu({
  facts,
  handlers,
  disabled = false,
  className,
  triggerLabel = "Reverse or refund",
}: TransactionActionMenuProps) {
  const rows = React.useMemo(() => evaluateEligibility(facts), [facts]);

  const handlerFor = (cmd: POSReversalCommandType): (() => void) => {
    switch (cmd) {
      case "void_sale":                  return handlers.onVoid;
      case "reverse_card_authorization": return handlers.onReverseCard;
      case "refund_sale":                return handlers.onRefund;
      case "return_goods":               return handlers.onReturn;
      case "exchange":                   return handlers.onExchange;
      case "issue_store_credit":         return handlers.onStoreCredit;
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className={cn("flex-1 text-destructive hover:text-destructive", className)}
        >
          <Ban className="h-4 w-4 mr-1" />
          {triggerLabel}
          <ChevronDown className="h-4 w-4 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
          Reversal actions
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <TooltipProvider>
          {rows.map((r) => {
            const meta = COMMAND_META[r.command];
            const Icon = meta.icon;
            const reasonKey = r.ineligibilityReason;
            const item = (
              <DropdownMenuItem
                key={r.command}
                disabled={!r.eligible}
                onSelect={(e) => {
                  if (!r.eligible) {
                    e.preventDefault();
                    return;
                  }
                  handlerFor(r.command)();
                }}
                className={cn(
                  "flex items-start gap-2 cursor-pointer",
                  meta.destructive && r.eligible && "text-destructive focus:text-destructive",
                )}
              >
                <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="font-medium">{meta.label}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {r.eligible
                      ? meta.description
                      : reasonKey
                        ? INELIGIBILITY_COPY[reasonKey]
                        : "Not available"}
                  </span>
                </div>
              </DropdownMenuItem>
            );
            if (r.eligible) return item;
            return (
              <Tooltip key={r.command}>
                <TooltipTrigger asChild>
                  {/* Wrap disabled item so tooltip still fires */}
                  <span>{item}</span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs">
                  {reasonKey ? INELIGIBILITY_COPY[reasonKey] : "Not available"}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default TransactionActionMenu;
