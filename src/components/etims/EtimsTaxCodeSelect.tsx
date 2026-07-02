import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEtimsStandardCodes } from "@/hooks/useEtimsStandardCodes";
import { Badge } from "@/components/ui/badge";
import { Info, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface EtimsTaxCodeSelectProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  required?: boolean;
  showLabel?: boolean;
  label?: string;
}

/**
 * eTIMS Tax Code selector — now reads from KRA-synced `etims_standard_codes`
 * (code_type = "tax_type") instead of the user-editable `etims_tax_categories`.
 */
export function EtimsTaxCodeSelect({
  value,
  onChange,
  disabled = false,
  required = false,
  showLabel = true,
  label = "eTIMS Tax Code",
}: EtimsTaxCodeSelectProps) {
  const { codes, isLoading } = useEtimsStandardCodes("tax_type");

  const activeCodes = codes.filter((c) => c.code_type === "tax_type");
  const selectedCode = value ? activeCodes.find((c) => c.code === value) : null;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {showLabel && <Label>{label}</Label>}
        <div className="flex items-center gap-2 h-10 px-3 border rounded-md bg-muted/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading tax codes...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {showLabel && (
        <div className="flex items-center gap-2">
          <Label>
            {label}
            {required && <span className="text-destructive ml-1">*</span>}
          </Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <p>
                  KRA eTIMS tax type code that will be transmitted to the tax
                  authority. These codes are synced from KRA standard codes.
                  Ensure your eTIMS device is initialized and codes are synced
                  via Settings → Tax Compliance.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select eTIMS tax code" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">
            <span className="text-muted-foreground">Not mapped</span>
          </SelectItem>
          {activeCodes.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No tax type codes synced.
              <br />
              Initialize your eTIMS device and sync codes first.
            </div>
          ) : (
            activeCodes.map((code) => (
              <SelectItem key={code.code} value={code.code}>
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="font-mono min-w-[24px] justify-center"
                  >
                    {code.code}
                  </Badge>
                  <span>{code.name}</span>
                </div>
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {selectedCode && selectedCode.description && (
        <p className="text-xs text-muted-foreground">
          {selectedCode.description}
        </p>
      )}
    </div>
  );
}
