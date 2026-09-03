/**
 * Client statement — the microfinance face of the inherited statement surface.
 *
 * Replaces the ERP "customer statement": one client, every loan, every money
 * movement in the period. Amounts are read from the server-owned
 * `mf_client_statement` view; the browser only orders them and carries the
 * running balance forward. Nothing is re-derived from raw loans or receipts.
 */
import { useCallback, useMemo } from "react";
import { format, startOfYear } from "date-fns";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { useMfClientStatement } from "@/hooks/useMfReports";
import { useMfClients } from "@/hooks/useMfClients";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { LendingDocumentsMenu } from "../documents/LendingDocumentsMenu";

const COLUMNS: ReportColumn[] = [
  { key: "entry_date", header: "Date", format: "date", width: "w-[120px]", sticky: true },
  { key: "description", header: "Description", width: "w-[220px]" },
  { key: "loan_number", header: "Loan", width: "w-[130px]" },
  { key: "method", header: "Method", width: "w-[130px]" },
  { key: "reference", header: "Reference", width: "w-[160px]" },
  { key: "amount_out", header: "Disbursed", format: "currency", width: "w-[140px]" },
  { key: "amount_in", header: "Repaid", format: "currency", width: "w-[140px]" },
  { key: "balance", header: "Running balance", format: "currency", width: "w-[150px]" },
];

export function ClientStatementReport() {
  const today = format(new Date(), "yyyy-MM-dd");
  const yearStart = format(startOfYear(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({ client: "", from: yearStart, to: today });
  const clientId = workspace.get("client", "");
  const from = workspace.get("from", yearStart);
  const to = workspace.get("to", today);

  const { clients, isLoading: clientsLoading } = useMfClients();
  const { rows: data, isLoading, error } = useMfClientStatement(clientId || null, from, to);

  const client = useMemo(
    () => clients.find((c) => c.id === clientId) ?? null,
    [clients, clientId],
  );

  const rows = useMemo<ReportRow[]>(() => {
    let balance = 0;
    const detail: ReportRow[] = data.map((r) => {
      balance += r.amount_out - r.amount_in;
      return {
        id: r.entry_id,
        kind: "detail" as const,
        values: {
          entry_date: r.entry_date,
          description: r.description,
          loan_number: r.loan_number,
          method: r.method ?? "—",
          reference: r.reference ?? "—",
          amount_out: r.amount_out || null,
          amount_in: r.amount_in || null,
          balance,
        },
      };
    });

    if (detail.length === 0) return detail;

    detail.push({
      id: "total",
      kind: "grandTotal",
      label: "Closing balance",
      values: {
        entry_date: "Closing balance",
        amount_out: data.reduce((acc, r) => acc + r.amount_out, 0),
        amount_in: data.reduce((acc, r) => acc + r.amount_in, 0),
        balance,
      },
    });
    return detail;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: client ? `Client statement — ${client.full_name}` : "Client statement",
      asOf: `${from} to ${to}`,
      columns: toExportColumns(COLUMNS as ReportColumn<never>[]),
      rows: toExportRows(rows, COLUMNS as ReportColumn<never>[]),
      sheetName: "Client statement",
    }),
    [rows, from, to, client],
  );

  return (
    <ReportPageLayout
      title="Client statement"
      description="Disbursements and repayments for one client across all their loans"
      isLoading={isLoading || clientsLoading}
      error={error}
      isEmpty={!isLoading && (!clientId || data.length === 0)}
      emptyMessage={
        clientId
          ? "No movements for this client in the selected period"
          : "Select a client to produce a statement"
      }
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap gap-4">
          <div className="w-72 space-y-1.5">
            <Label>Client</Label>
            <Select
              value={clientId || undefined}
              onValueChange={(value) => workspace.set({ client: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.full_name} ({c.client_number})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44 space-y-1.5">
            <Label>From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => workspace.set({ from: e.target.value })}
            />
          </div>
          <div className="w-44 space-y-1.5">
            <Label>To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => workspace.set({ to: e.target.value })}
            />
          </div>
          {client ? (
            <div className="flex items-end">
              <LendingDocumentsMenu
                documents={[
                  {
                    documentType: "client_statement",
                    documentId: client.id,
                    title: "Client Statement",
                    filename: `client-statement-${client.client_number}`,
                  },
                ]}
              />
            </div>
          ) : null}
        </div>
      }
    >
      <ReportSurface
        title={client ? `Client statement — ${client.full_name}` : "Client statement"}
        asOfDate={`${from} — ${to}`}
      >
        <ReportTable columns={COLUMNS as ReportColumn<never>[]} rows={rows} />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default ClientStatementReport;
