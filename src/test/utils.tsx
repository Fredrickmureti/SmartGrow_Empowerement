import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { vi } from 'vitest';

// Create a custom render function with providers
const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

// Mock Auth Context
const mockAuthContext = {
  user: { id: 'test-user-id', email: 'test@example.com' },
  session: { access_token: 'test-token' },
  isLoading: false,
  signOut: vi.fn(),
};

// Mock Organization Context
const mockOrganizationContext = {
  currentOrg: {
    id: 'test-org-id',
    name: 'Test Organization',
    slug: 'test-org',
  },
  organizations: [],
  isLoading: false,
};

// Mock Currency Context
const mockCurrencyContext = {
  currency: 'KES',
  setCurrency: vi.fn(),
  formatCurrency: (amount: number) => `KES ${amount.toLocaleString()}`,
  exchangeRates: {},
  isLoading: false,
};

// Create mock context providers
const MockAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const AuthContext = React.createContext(mockAuthContext);
  return <AuthContext.Provider value={mockAuthContext}>{children}</AuthContext.Provider>;
};

interface AllTheProvidersProps {
  children: React.ReactNode;
}

const AllTheProviders: React.FC<AllTheProvidersProps> = ({ children }) => {
  const queryClient = createTestQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {children}
      </BrowserRouter>
    </QueryClientProvider>
  );
};

const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllTheProviders, ...options });

// Re-export everything
export * from '@testing-library/react';
export { customRender as render };

// Export mock contexts for test access
export {
  mockAuthContext,
  mockOrganizationContext,
  mockCurrencyContext,
  createTestQueryClient,
};
