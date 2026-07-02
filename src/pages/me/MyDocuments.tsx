/**
 * MyDocuments — employee self-service at /me/documents.
 *
 * Lists the signed-in employee's own documents (contracts, policies,
 * certificates) with a per-row "Download" action and an "Acknowledge"
 * button for any document not yet acknowledged. Acknowledgement is
 * persistent and timestamped via the `acknowledge_employee_document` RPC
 * (the only write path an employee has — see useMyDocuments).
 */
import { format, parseISO } from "date-fns";
import { Download, FileText, CheckCircle2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMyDocuments, type MyDocument } from "@/hooks/hr/useMyDocuments";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ doc }: { doc: MyDocument }) {
  if (doc.acknowledged_at) {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Acknowledged {format(parseISO(doc.acknowledged_at), "d MMM yyyy")}
      </Badge>
    );
  }
  return <Badge variant="outline">Awaiting acknowledgement</Badge>;
}

export default function MyDocuments() {
  const { documents, isLoading, download, acknowledge } = useMyDocuments();

  const pending = documents.filter((d) => !d.acknowledged_at).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6" />
          My Documents
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Contracts, policies, certificates and other documents shared with you by HR.
          {pending > 0 ? ` You have ${pending} item${pending === 1 ? "" : "s"} awaiting acknowledgement.` : ""}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Document library</CardTitle>
          <CardDescription>
            Download to read the original; click <strong>Acknowledge</strong> to confirm you have
            read and understood. Acknowledgements are timestamped and form part of your HR record.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : documents.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              No documents have been shared with you yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="font-medium">
                      <div>{doc.name}</div>
                      {doc.description && (
                        <div className="text-xs text-muted-foreground">{doc.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {doc.document_type || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBytes(doc.file_size)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge doc={doc} />
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => download(doc)}
                        disabled={!doc.file_path}
                      >
                        <Download className="h-4 w-4 mr-1" />
                        Download
                      </Button>
                      {!doc.acknowledged_at && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => acknowledge(doc.id)}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          Acknowledge
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}