/**
 * PayrollReportPreview — dispatches to the correct preview surface based
 * on the definition's `preview_kind`. New preview kinds are added by
 * extending this switch and the DB check constraint together.
 *
 * Every preview receives the same `columns` + `rows` payload that
 * `render-report` returns; the shape of the preview is the presentation
 * concern, not a data concern. Statutory-form and certificate previews
 * are declared here for the registry contract but delegate to the
 * existing engines when engaged from their owning routes.
 */
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrency } from "@/hooks/useCurrency";
import type { PayrollReportDefinition } from "@/hooks/payroll/usePayrollReportDefinitions";

interface Column {
  key: string;
  header: string;
  format?: string;
  align?: string;
}

interface Props {
  definition: PayrollReportDefinition;
  columns: Column[];
  rows: any[];
  canSeeMoney: boolean;
}

const isMoneyCol = (col: Column) =>
  col.format === "currency" || /amount|total|gross|net|pay|cost/i.test(col.key);

function MoneyOrHidden({
  value,
  canSee,
  format,
}: {
  value: any;
  canSee: boolean;
  format: (n: number) => string;
}) {
  if (value == null || value === "") return <>—</>;
  if (!canSee) {
    return (
      <Badge variant="secondary" className="font-normal">
        Hidden
      </Badge>
    );
  }
  return <>{format(Number(value) || 0)}</>;
}

function TablePreview({ columns, rows, canSeeMoney }: Props) {
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();
  const handleRowClick = (row: any) => {
    const meta = (row as any)._meta;
    if (!meta) return;
    if (meta.sourceDocType === "payslip" && meta.sourceDocId)
      navigate(`/hr/payroll/payslips/${meta.sourceDocId}`);
    else if (meta.sourceDocType === "payroll_run" && meta.sourceDocId)
      navigate(`/hr/payroll/runs/${meta.sourceDocId}`);
    else if (meta.sourceDocType === "payroll_liability" && meta.ruleCode)
      navigate(
        `/hr/payroll/remittances?ruleCode=${encodeURIComponent(meta.ruleCode)}`,
      );
  };
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={c.align === "right" ? "text-right" : undefined}
                >
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow
                key={i}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleRowClick(r)}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={c.align === "right" ? "text-right" : undefined}
                  >
                    {r[c.key] == null || r[c.key] === "" ? (
                      "—"
                    ) : isMoneyCol(c) ? (
                      <MoneyOrHidden
                        value={r[c.key]}
                        canSee={canSeeMoney}
                        format={formatCurrency}
                      />
                    ) : (
                      String(r[c.key])
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SummaryPreview(props: Props) {
  // SummaryPreview used to render its own KPI strip above the table.
  // KPIs now live in the viewer-owned `PayrollReportKpiBand`, so this
  // preview just delegates to the table body.
  return <TablePreview {...props} />;
}

function DashboardPreview(props: Props) {
  // Dashboard preview is additive — for now it renders the summary card
  // strip above the same table. Chart widgets land in a follow-up.
  return <SummaryPreview {...props} />;
}

function MatrixPreview(props: Props) {
  // Matrix defaults to a wide tabular view; when the payload declares a
  // pivot axis in _meta a future upgrade will pivot it here without a
  // component change on the caller side.
  return <TablePreview {...props} />;
}

function StatutoryFormPreview(props: Props) {
  // Placeholder for the form-facsimile preview delegated to the
  // statutory-return engine. Until the pack publisher wires the
  // report_key → template binding, we fall back to the table so a
  // country pack can still surface its report without a preview refresh.
  return <TablePreview {...props} />;
}

function CertificatePreview(props: Props) {
  // Certificate preview is owned by generate-tax-certificate and is
  // rendered from the Tax Certificates surface; here we show the tabular
  // dataset that backs the certificate for auditability.
  return <TablePreview {...props} />;
}

export function PayrollReportPreview(props: Props) {
  switch (props.definition.previewKind) {
    case "summary":
      return <SummaryPreview {...props} />;
    case "dashboard":
      return <DashboardPreview {...props} />;
    case "matrix":
      return <MatrixPreview {...props} />;
    case "statutory_form":
      return <StatutoryFormPreview {...props} />;
    case "certificate":
      return <CertificatePreview {...props} />;
    case "table":
    default:
      return <TablePreview {...props} />;
  }
}

export default PayrollReportPreview;
