import { Globe } from "lucide-react";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useCountryWorkspace } from "@/contexts/CountryWorkspaceContext";
import { useCountries } from "@/hooks/useCountries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export function CountryWorkspaceSelector() {
  const { countryScopes, isGlobalAccess, isOperator } = usePlatformPermissions();
  const { selectedCountry, setSelectedCountry } = useCountryWorkspace();
  const { countries } = useCountries();

  const countryMap = new Map(countries.map(c => [c.code, c.name]));

  // For operators with scopes, show only their assigned countries
  // For owner/admin, show all countries that have orgs or localization packs
  const selectableCountries = isGlobalAccess
    ? countries
    : countries.filter(c => countryScopes.includes(c.code));

  // If operator has only 1 country, show it as a badge instead of dropdown
  if (isOperator && countryScopes.length === 1) {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <Globe className="h-3 w-3" />
        {countryMap.get(countryScopes[0]) || countryScopes[0]}
      </Badge>
    );
  }

  // If operator has no scopes (restricted), show restricted badge
  if (isOperator && countryScopes.length === 0) {
    return (
      <Badge variant="destructive" className="gap-1 text-xs">
        <Globe className="h-3 w-3" />
        No countries assigned
      </Badge>
    );
  }

  return (
    <Select value={selectedCountry} onValueChange={setSelectedCountry}>
      <SelectTrigger className="w-auto max-w-[180px] h-9 text-xs">
        <Globe className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
        <SelectValue placeholder="All Countries" />
      </SelectTrigger>
      <SelectContent>
        {isGlobalAccess && (
          <SelectItem value="all">All Countries</SelectItem>
        )}
        {selectableCountries.map(c => (
          <SelectItem key={c.code} value={c.code}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
