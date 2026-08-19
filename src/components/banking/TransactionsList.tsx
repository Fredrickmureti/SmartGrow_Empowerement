import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Search, 
  ArrowUpRight, 
  ArrowDownLeft,
  CheckCircle2
} from "lucide-react";
import { formatDate, cn } from "@/lib/utils";
import { useBankMoney } from "@/hooks/useBankAccountCurrency";

interface Transaction {
  id: string;
  transaction_date: string;
  description: string;
  reference?: string;
  amount: number;
  transaction_type: string;
  category?: string;
  is_reconciled: boolean;
  balance_after?: number;
  bank_account_id?: string | null;
}

interface TransactionsListProps {
  transactions: Transaction[];
  isLoading?: boolean;
}

/**
 * Currency contract (ADR 0136): a bank line is denominated in its account's
 * currency, resolved through `useBankMoney`. Nothing here falls back to the
 * workspace currency or to a literal.
 */

export function TransactionsList({ transactions, isLoading }: TransactionsListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const { formatBankAmount } = useBankMoney();

  const filteredTransactions = transactions.filter((tx) => {
    const matchesSearch = 
      tx.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tx.reference?.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesType = typeFilter === "all" || tx.transaction_type === typeFilter;

    return matchesSearch && matchesType;
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="h-64 flex items-center justify-center">
            <p className="text-muted-foreground">Loading transactions...</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {/* Filters */}
        <div className="flex gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search transactions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="credit">Credits</SelectItem>
              <SelectItem value="debit">Debits</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTransactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No transactions found
                </TableCell>
              </TableRow>
            ) : (
              filteredTransactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDate(tx.transaction_date)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {tx.transaction_type === 'credit' ? (
                        <ArrowDownLeft className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <ArrowUpRight className="h-4 w-4 text-destructive shrink-0" />
                      )}
                      <span className="truncate max-w-[250px]">{tx.description}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tx.reference || '-'}
                  </TableCell>
                  <TableCell>
                    {tx.category ? (
                      <Badge variant="secondary" className="text-xs">
                        {tx.category}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">-</span>
                    )}
                  </TableCell>
                  <TableCell className={cn(
                    "text-right font-medium",
                    tx.transaction_type === 'credit' ? 'text-green-600' : 'text-destructive'
                  )}>
                    {tx.transaction_type === 'credit' ? '+' : '-'}
                    {formatBankAmount(Math.abs(tx.amount), tx.bank_account_id)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {tx.balance_after !== undefined ? formatBankAmount(tx.balance_after, tx.bank_account_id) : '-'}
                  </TableCell>
                  <TableCell>
                    {tx.is_reconciled ? (
                      <Badge variant="secondary" className="bg-green-100 text-green-800">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Matched
                      </Badge>
                    ) : (
                      <Badge variant="outline">Pending</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
