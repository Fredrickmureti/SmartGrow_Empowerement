import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Clock, XCircle, ExternalLink } from "lucide-react";

interface EtimsQRCodeProps {
  cuNumber?: string | null;
  signature?: string | null;
  transmittedAt?: string | null;
  verificationUrl?: string | null;
  qrCodeData?: string | null;
  size?: number;
  showDetails?: boolean;
  className?: string;
}

export function EtimsQRCode({
  cuNumber,
  signature,
  transmittedAt,
  verificationUrl,
  qrCodeData,
  size = 128,
  showDetails = true,
  className = "",
}: EtimsQRCodeProps) {
  // Generate QR code data if not provided
  const qrData = qrCodeData || verificationUrl || (cuNumber 
    ? `https://etims.kra.go.ke/verify/${cuNumber}` 
    : null);

  const getStatus = () => {
    if (cuNumber && transmittedAt) return "transmitted";
    if (cuNumber) return "pending";
    return "not_transmitted";
  };

  const status = getStatus();

  const statusConfig = {
    transmitted: {
      label: "Transmitted to KRA",
      variant: "default" as const,
      icon: CheckCircle,
      color: "text-green-600",
    },
    pending: {
      label: "Pending Verification",
      variant: "secondary" as const,
      icon: Clock,
      color: "text-yellow-600",
    },
    not_transmitted: {
      label: "Not Transmitted",
      variant: "outline" as const,
      icon: XCircle,
      color: "text-muted-foreground",
    },
  };

  const currentStatus = statusConfig[status];
  const StatusIcon = currentStatus.icon;

  if (!qrData && !showDetails) {
    return null;
  }

  if (!showDetails && qrData) {
    return (
      <div className={`inline-block p-2 bg-white rounded ${className}`}>
        <QRCodeSVG
          value={qrData}
          size={size}
          level="M"
          includeMargin={false}
        />
      </div>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span>eTIMS Status</span>
          <Badge variant={currentStatus.variant} className="ml-2">
            <StatusIcon className={`h-3 w-3 mr-1 ${currentStatus.color}`} />
            {currentStatus.label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {qrData ? (
          <div className="flex justify-center p-3 bg-white rounded-lg">
            <QRCodeSVG
              value={qrData}
              size={size}
              level="M"
              includeMargin={false}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 bg-muted rounded-lg">
            <p className="text-sm text-muted-foreground">
              QR code will appear after KRA transmission
            </p>
          </div>
        )}

        {cuNumber && (
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Control Unit Number</p>
            <p className="font-mono font-medium text-sm">{cuNumber}</p>
          </div>
        )}

        {transmittedAt && (
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Transmitted</p>
            <p className="text-sm">
              {new Date(transmittedAt).toLocaleString()}
            </p>
          </div>
        )}

        {signature && (
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Digital Signature</p>
            <p className="font-mono text-xs truncate" title={signature}>
              {signature.substring(0, 20)}...
            </p>
          </div>
        )}

        {verificationUrl && (
          <a
            href={verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1 text-sm text-primary hover:underline"
          >
            Verify on KRA Portal
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}

// Compact version for invoice/receipt PDF embedding
export function EtimsQRCodeCompact({
  cuNumber,
  verificationUrl,
  qrCodeData,
  size = 80,
}: Pick<EtimsQRCodeProps, "cuNumber" | "verificationUrl" | "qrCodeData" | "size">) {
  const qrData = qrCodeData || verificationUrl || (cuNumber 
    ? `https://etims.kra.go.ke/verify/${cuNumber}` 
    : null);

  if (!qrData) return null;

  return (
    <div className="inline-flex flex-col items-center gap-1">
      <div className="p-1 bg-white rounded">
        <QRCodeSVG
          value={qrData}
          size={size}
          level="M"
          includeMargin={false}
        />
      </div>
      {cuNumber && (
        <p className="text-xs font-mono text-center">{cuNumber}</p>
      )}
    </div>
  );
}
