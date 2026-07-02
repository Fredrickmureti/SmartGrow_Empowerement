import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";

interface CountryWorkspaceContextType {
  selectedCountry: string; // "all" or country code
  setSelectedCountry: (country: string) => void;
  availableCountries: string[];
  isFiltered: boolean;
}

const CountryWorkspaceContext = createContext<CountryWorkspaceContextType>({
  selectedCountry: "all",
  setSelectedCountry: () => {},
  availableCountries: [],
  isFiltered: false,
});

export function CountryWorkspaceProvider({ children }: { children: ReactNode }) {
  const { countryScopes, isGlobalAccess } = usePlatformPermissions();
  const [selectedCountry, setSelectedCountryState] = useState<string>("all");

  const setSelectedCountry = useCallback((country: string) => {
    // Operators can only select from their scopes
    if (!isGlobalAccess && country !== "all" && !countryScopes.includes(country)) {
      return;
    }
    setSelectedCountryState(country);
  }, [isGlobalAccess, countryScopes]);

  // Available countries for the selector
  const availableCountries = isGlobalAccess ? [] : countryScopes;
  const isFiltered = selectedCountry !== "all";

  return (
    <CountryWorkspaceContext.Provider value={{
      selectedCountry,
      setSelectedCountry,
      availableCountries,
      isFiltered,
    }}>
      {children}
    </CountryWorkspaceContext.Provider>
  );
}

export function useCountryWorkspace() {
  return useContext(CountryWorkspaceContext);
}
