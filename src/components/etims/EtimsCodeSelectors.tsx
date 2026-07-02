import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  ETIMS_UNIT_CODES,
  ETIMS_PACKAGING_CODES,
  useEtimsStandardCodes,
} from "@/hooks/useEtimsStandardCodes";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { CountryCombobox } from "@/components/contacts/CountryCombobox";
import { useCountries } from "@/hooks/useCountries";

interface EtimsUnitCodeSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

export function EtimsUnitCodeSelect({
  value,
  onChange,
  disabled = false,
  label = "Tax quantity code",
}: EtimsUnitCodeSelectProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value || "U"}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select code" />
        </SelectTrigger>
        <SelectContent>
          {ETIMS_UNIT_CODES.map((unit) => (
            <SelectItem key={unit.code} value={unit.code}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono min-w-[36px] justify-center">
                  {unit.code}
                </Badge>
                <span>{unit.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        KRA-mandated code transmitted with every invoice. Not the same as your inventory unit.
      </p>
    </div>
  );
}


interface EtimsPackagingCodeSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

export function EtimsPackagingCodeSelect({
  value,
  onChange,
  disabled = false,
  label = "Tax packaging code",
}: EtimsPackagingCodeSelectProps) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value || "CT"}
        onValueChange={onChange}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select code" />
        </SelectTrigger>
        <SelectContent>
          {ETIMS_PACKAGING_CODES.map((pkg) => (
            <SelectItem key={pkg.code} value={pkg.code}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono min-w-[36px] justify-center">
                  {pkg.code}
                </Badge>
                <span>{pkg.name}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        KRA-mandated code transmitted with every invoice. Separate from your inventory packs.
      </p>
    </div>
  );
}


interface EtimsClassificationCodeSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

export function EtimsClassificationCodeSelect({
  value,
  onChange,
  disabled = false,
  label = "Item Classification (UNSPSC)",
}: EtimsClassificationCodeSelectProps) {
  const { classificationCodes, isLoading } = useEtimsStandardCodes("item_classification");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredCodes = classificationCodes.filter(
    (c) =>
      c.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Common classification codes if no synced codes available
  const commonCodes = [
    { code: "5020101", name: "Electronics and Appliances" },
    { code: "5010101", name: "Food and Beverages" },
    { code: "5030101", name: "Clothing and Textiles" },
    { code: "5040101", name: "Furniture and Furnishings" },
    { code: "5050101", name: "Automotive Parts" },
    { code: "5060101", name: "Health and Medical" },
    { code: "5070101", name: "Office Supplies" },
    { code: "5080101", name: "Building Materials" },
    { code: "5090101", name: "Professional Services" },
    { code: "5100101", name: "Transportation Services" },
  ];

  const displayCodes = classificationCodes.length > 0 ? filteredCodes : commonCodes;

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="space-y-2">
        <Input
          placeholder="Search or enter classification code..."
          value={value || ""}
          onChange={(e) => {
            onChange(e.target.value);
            setSearchQuery(e.target.value);
          }}
          disabled={disabled}
        />
        {searchQuery && displayCodes.length > 0 && (
          <div className="border rounded-md max-h-40 overflow-y-auto">
            {displayCodes.slice(0, 10).map((code) => (
              <button
                key={code.code}
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2 text-sm"
                onClick={() => {
                  onChange(code.code);
                  setSearchQuery("");
                }}
              >
                <Badge variant="outline" className="font-mono">
                  {code.code}
                </Badge>
                <span className="truncate">{code.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        UNSPSC code for KRA eTIMS classification
      </p>
    </div>
  );
}

interface EtimsCountryOriginSelectProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

export function EtimsCountryOriginSelect({
  value,
  onChange,
  disabled = false,
  label = "Country of Origin",
}: EtimsCountryOriginSelectProps) {
  const { countries, isLoading } = useCountries();

  // Fallback list (used while countries are loading or if the table is empty)
  const fallbackCountries = [
    { code: "KE", name: "Kenya", currency: "KES" },
    { code: "CN", name: "China", currency: "CNY" },
    { code: "IN", name: "India", currency: "INR" },
    { code: "AE", name: "United Arab Emirates", currency: "AED" },
    { code: "ZA", name: "South Africa", currency: "ZAR" },
    { code: "UG", name: "Uganda", currency: "UGX" },
    { code: "TZ", name: "Tanzania", currency: "TZS" },
    { code: "US", name: "United States", currency: "USD" },
    { code: "GB", name: "United Kingdom", currency: "GBP" },
    { code: "DE", name: "Germany", currency: "EUR" },
    { code: "JP", name: "Japan", currency: "JPY" },
    { code: "KR", name: "South Korea", currency: "KRW" },
    { code: "EG", name: "Egypt", currency: "EGP" },
    { code: "NG", name: "Nigeria", currency: "NGN" },
    { code: "RW", name: "Rwanda", currency: "RWF" },
  ];

  const list = countries.length > 0 ? countries : fallbackCountries;

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <CountryCombobox
        countries={list}
        value={value || "KE"}
        onValueChange={onChange}
        placeholder={isLoading ? "Loading countries..." : "Search country..."}
        disabled={disabled}
      />
    </div>
  );
}
