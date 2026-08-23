/**
 * JournalLineRow — the ONE line editor for double-entry documents: manual
 * journal entries, recurring journal templates and year-end closing entries.
 *
 * Journal lines are the only line contract in the platform with no product,
 * no quantity and no price: they carry account / description / optional
 * subledger party / debit / credit. That is genuinely distinct from
 * `PricedLineRow` and `RequestLineRow`, so it earns its own row component
 * rather than a pile of dead columns.
 *
 * Business rules preserved from the previous bespoke table:
 *  - debit and credit are mutually exclusive per line (entering one disables
 *    the other);
 *  - a line posting to an AR/AP control account MUST name a customer/vendor,
 *    otherwise the subledger drifts from the GL. The party cell renders in
 *    an invalid state until one is chosen, and the column is omitted entirely
 *    for lines that do not need it.
 *
 * Renders into the measured layout of `EditableLineItemsGrid`: columns the
 * container cannot hold are demoted onto a labelled secondary line instead
 * of forcing horizontal scroll.
 *
 * Props MUST be stable from the parent (`useCallback` the handlers) or the
 * memo will not engage.
 */

import { memo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { ContactCombobox } from "@/components/finance/ContactCombobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EditableLineRowCells,
  type EditableLineColumn,
  type EditableRowLayout,
} from "@/design-system/records/EditableLineItemsGrid";

/** Sentinel for "no analytic attribution" — Radix Select forbids empty values. */
const NO_ANALYTIC = "__none__";

/** Subledger role a GL account imposes on the line, if any. */
export type JournalControlRole = "ar" | "ap" | null;

/** Minimum line shape every double-entry document satisfies. */
export interface JournalLineShape {
  account_id: string;
  description: string;
  debit: number;
  credit: number;
  contact_id?: string;
  /**
   * Analytic (cost centre / project / department …) attribution for this line.
   * The posting engine copies it onto `journal_entry_lines.analytic_account_id`,
   * from which the database materialises the analytic ledger. The client never
   * writes analytic amounts itself.
   */
  analytic_account_id?: string | null;
}

/** Postable analytic account offered on a journal line. */
export interface JournalAnalyticOption {
  id: string;
  code: string | null;
  name: string;
  planName?: string | null;
}

/** Column contract shared by every double-entry line editor. */
export const JOURNAL_LINE_COLUMNS: EditableLineColumn[] = [
  { id: "account", header: "Account", priority: 1, minWidth: 220 },
  {
    id: "description",
    header: "Description",
    priority: 3,
    minWidth: 180,
    compactLabel: "Description",
  },
  {
    id: "party",
    header: "Customer / Vendor",
    priority: 2,
    minWidth: 180,
    compactLabel: "Party",
  },
  {
    id: "analytic",
    header: "Analytic",
    priority: 4,
    minWidth: 180,
    compactLabel: "Analytic",
  },
  { id: "debit", header: "Debit", priority: 1, minWidth: 110, numeric: true },
  { id: "credit", header: "Credit", priority: 1, minWidth: 110, numeric: true },
];

interface Props<T extends JournalLineShape> {
  index: number;
  item: T;
  /** Chart of accounts feeding the account picker. */
  accounts: Parameters<typeof AccountCombobox>[0]["accounts"];
  /** Contacts feeding the subledger party picker. */
  contacts: Parameters<typeof ContactCombobox>[0]["contacts"];
  /** Resolves whether the chosen account is an AR/AP control account. */
  controlRole: JournalControlRole;
  /** Postable analytic accounts; omit/empty to hide the analytic cell. */
  analyticAccounts?: JournalAnalyticOption[];
  /** Layout resolved by `EditableLineItemsGrid` for the measured container. */
  layout: EditableRowLayout;
  disabled?: boolean;
  /** Applies a partial update to the line. */
  onPatch: (index: number, patch: Partial<T>) => void;
  /** Rendered full width beneath the row. */
  extra?: ReactNode;
}

function JournalLineRowInner<T extends JournalLineShape>({
  index,
  item,
  accounts,
  contacts,
  controlRole,
  analyticAccounts,
  layout,
  disabled,
  onPatch,
  extra,
}: Props<T>) {
  const cell = (columnId: string) => {
    switch (columnId) {
      case "account":
        return (
          <AccountCombobox
            accounts={accounts}
            value={item.account_id}
            onValueChange={(v) => onPatch(index, { account_id: v } as Partial<T>)}
            placeholder="Search account…"
          />
        );

      case "description":
        return (
          <Input
            value={item.description}
            onChange={(e) =>
              onPatch(index, { description: e.target.value } as Partial<T>)
            }
            placeholder="Line description"
            className="h-8"
            disabled={disabled}
          />
        );

      case "party":
        if (!controlRole) {
          return (
            <span className="block truncate text-xs text-muted-foreground">—</span>
          );
        }
        return (
          <ContactCombobox
            contacts={contacts}
            role={controlRole === "ar" ? "customer" : "supplier"}
            value={item.contact_id}
            onValueChange={(v) => onPatch(index, { contact_id: v ?? "" } as Partial<T>)}
            invalid={!item.contact_id}
            placeholder={controlRole === "ar" ? "Customer *" : "Vendor *"}
          />
        );

      case "analytic": {
        if (!analyticAccounts || analyticAccounts.length === 0) {
          return (
            <span className="block truncate text-xs text-muted-foreground">—</span>
          );
        }
        return (
          <Select
            value={item.analytic_account_id ?? NO_ANALYTIC}
            disabled={disabled}
            onValueChange={(v) =>
              onPatch(index, {
                analytic_account_id: v === NO_ANALYTIC ? null : v,
              } as Partial<T>)
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ANALYTIC}>None</SelectItem>
              {analyticAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code ? `${a.code} — ${a.name}` : a.name}
                  {a.planName ? ` (${a.planName})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }

      case "debit":
        return (
          <NumericInput
            value={item.debit || null}
            onValueChange={(v) => onPatch(index, { debit: v ?? 0 } as Partial<T>)}
            disabled={disabled || item.credit > 0}
            className="h-8 text-right"
          />
        );

      case "credit":
        return (
          <NumericInput
            value={item.credit || null}
            onValueChange={(v) => onPatch(index, { credit: v ?? 0 } as Partial<T>)}
            disabled={disabled || item.debit > 0}
            className="h-8 text-right"
          />
        );

      default:
        return null;
    }
  };

  return <EditableLineRowCells layout={layout} cell={cell} extra={extra} />;
}

export const JournalLineRow = memo(JournalLineRowInner) as typeof JournalLineRowInner;
