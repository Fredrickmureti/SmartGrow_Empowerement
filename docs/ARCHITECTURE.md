# AccrualFlow System Architecture

> **Version:** 2.1.0  
> **Last Updated:** February 2026  
> **Maintainers:** AccrualFlow Engineering Team

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Technology Stack](#technology-stack)
4. [Frontend Architecture](#frontend-architecture)
5. [Backend Architecture](#backend-architecture)
6. [Database Schema](#database-schema)
7. [Multi-Tenancy Model](#multi-tenancy-model)
8. [Authentication & Authorization](#authentication--authorization)
9. [POS System](#pos-system)
10. [Electron Desktop App](#electron-desktop-app)
11. [Edge Functions Reference](#edge-functions-reference)
12. [Integration APIs](#integration-apis)
13. [Realtime & Sync](#realtime--sync)
14. [Testing Strategy](#testing-strategy)
15. [Deployment Guide](#deployment-guide)
16. [Developer Onboarding](#developer-onboarding)
17. [Troubleshooting](#troubleshooting)
18. [Security Considerations](#security-considerations)

---

## Executive Summary

### What is AccrualFlow?

AccrualFlow is a comprehensive **Enterprise Resource Planning (ERP)** and **Point of Sale (POS)** system designed specifically for businesses operating in Kenya and the East African region. It provides:

- **Full Accounting Suite**: General ledger, accounts payable/receivable, invoicing, bills
- **Inventory Management**: Multi-warehouse, stock tracking, low-stock alerts
- **Point of Sale**: Offline-first POS with receipt printing and M-Pesa integration
- **KRA eTIMS Compliance**: Automatic tax invoice transmission to Kenya Revenue Authority
- **Multi-Business Support**: Single organization can manage multiple businesses/branches
- **Payroll & HR**: Employee management, leave tracking, payroll processing
- **Project Management**: Tasks, time tracking, project billing

### Target Users

| User Type | Use Case |
|-----------|----------|
| **Small Retailers** | Single-store POS with eTIMS compliance |
| **Medium Businesses** | Multi-branch inventory and accounting |
| **Enterprises** | Multi-company consolidation, complex workflows |
| **Accountants** | Client management across organizations |

### Key Differentiators

1. **Kenya-First Design**: eTIMS integration, M-Pesa payments, KRA-compliant invoicing
2. **Offline-First POS**: Works without internet, syncs when connected
3. **Multi-Tenancy**: Organization → Business → Branch hierarchy
4. **Desktop + Web**: Electron app for hardware (printers, scanners)

---

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐           │
│  │   Web Browser   │   │  Electron App   │   │ Mobile (Future) │           │
│  │  (React + Vite) │   │ (Node + Native) │   │                 │           │
│  └────────┬────────┘   └────────┬────────┘   └─────────────────┘           │
│           │                     │                                           │
│           │    ┌────────────────┘                                           │
│           │    │   Hardware Access (USB/Serial)                             │
│           │    │   - Receipt Printers (ESC/POS)                             │
│           │    │   - Barcode Scanners                                       │
│           │    │   - Cash Drawers                                           │
│           ▼    ▼                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS / WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SUPABASE PLATFORM                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │   PostgreSQL     │  │  Edge Functions  │  │    GoTrue Auth   │          │
│  │   (100+ Tables)  │  │  (40+ Functions) │  │   (JWT + OAuth)  │          │
│  │                  │  │                  │  │                  │          │
│  │  • Organizations │  │  • AI Assistant  │  │  • Email/Pass    │          │
│  │  • Businesses    │  │  • M-Pesa APIs   │  │  • OAuth2        │          │
│  │  • Invoices      │  │  • eTIMS APIs    │  │  • Magic Links   │          │
│  │  • Products      │  │  • PDF Gen       │  │  • MFA           │          │
│  │  • Transactions  │  │  • Email Send    │  │                  │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│                                                                             │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │    Realtime      │  │     Storage      │  │    PostgREST     │          │
│  │   (WebSocket)    │  │   (S3-compat)    │  │   (REST API)     │          │
│  │                  │  │                  │  │                  │          │
│  │  • Live updates  │  │  • Logos         │  │  • Auto CRUD     │          │
│  │  • Presence      │  │  • Attachments   │  │  • RLS enforced  │          │
│  │  • Broadcasts    │  │  • Documents     │  │  • Full-text     │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
           │   KRA eTIMS  │ │  Safaricom   │ │   Resend     │
           │   (Tax API)  │ │  M-Pesa API  │ │  (Email)     │
           │              │ │              │ │              │
           │  • Invoice   │ │  • STK Push  │ │  • Invoices  │
           │  • Credit    │ │  • C2B       │ │  • Receipts  │
           │  • POS Sale  │ │  • Query     │ │  • Alerts    │
           └──────────────┘ └──────────────┘ └──────────────┘
```

### Data Flow Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         REQUEST FLOW                                        │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. User Action (e.g., Create Invoice)                                     │
│         │                                                                  │
│         ▼                                                                  │
│  2. React Component calls TanStack Query mutation                          │
│         │                                                                  │
│         ▼                                                                  │
│  3. Supabase Client (supabase.from('invoices').insert())                  │
│         │                                                                  │
│         ├────────────────────────────────────────┐                        │
│         ▼                                        ▼                        │
│  4a. PostgREST validates JWT              4b. RLS Policy Check            │
│         │                                        │                        │
│         └─────────────┬──────────────────────────┘                        │
│                       ▼                                                    │
│  5. PostgreSQL Insert (with triggers)                                      │
│         │                                                                  │
│         ├─────────────────────────────────────────────┐                   │
│         ▼                                             ▼                   │
│  6a. Trigger: Generate invoice_number          6b. Audit log entry        │
│         │                                                                  │
│         ▼                                                                  │
│  7. Realtime broadcasts change to all subscribers                          │
│         │                                                                  │
│         ▼                                                                  │
│  8. React Query cache invalidated → UI updates                             │
│         │                                                                  │
│         ▼                                                                  │
│  9. (Optional) Edge Function: send-invoice-email                           │
│         │                                                                  │
│         ▼                                                                  │
│  10. (Optional) Edge Function: etims-transmit-invoice                      │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### POS Transaction Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                    POS TRANSACTION FLOW                                     │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. Cashier scans barcode / selects product                                │
│         │                                                                  │
│         ▼                                                                  │
│  2. usePOSCart hook updates local cart state                               │
│         │                                                                  │
│         ▼                                                                  │
│  3. Customer pays (Cash / M-Pesa / Card)                                   │
│         │                                                                  │
│         ├─── M-Pesa ───► STK Push ───► Wait for callback                  │
│         │                                                                  │
│         ▼                                                                  │
│  4. Complete Transaction                                                   │
│         │                                                                  │
│    ┌────┴────┐                                                            │
│    │         │                                                            │
│    ▼         ▼                                                            │
│  ONLINE   OFFLINE                                                          │
│    │         │                                                            │
│    ▼         ▼                                                            │
│  5a. Supabase   5b. IndexedDB Queue                                        │
│      RPC call        (usePOSOffline)                                       │
│    │                  │                                                    │
│    │                  │ ──── When online ────►                             │
│    │                  │                       │                            │
│    ▼                  └───────────────────────┘                            │
│  6. Database Function: process_pos_transaction()                           │
│         │                                                                  │
│         ├── Check stock availability (FOR UPDATE lock)                     │
│         ├── Create pos_transactions record                                 │
│         ├── Create pos_transaction_items                                   │
│         ├── Create pos_transaction_payments                                │
│         ├── Deduct stock from products/warehouse_stock                     │
│         │                                                                  │
│         ▼                                                                  │
│  7. Generate receipt (ESC/POS format)                                      │
│         │                                                                  │
│         ├─── Web ───► Browser print dialog                                 │
│         ├─── Electron ───► Direct USB/Network print                        │
│         │                                                                  │
│         ▼                                                                  │
│  8. (If eTIMS enabled) etims-transmit-pos Edge Function                    │
│         │                                                                  │
│         ▼                                                                  │
│  9. Receipt shows eTIMS QR code + verification URL                         │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| **React** | 18.3 | UI framework |
| **TypeScript** | 5.6 | Type safety |
| **Vite** | 6.0 | Build tool, dev server |
| **TanStack Query** | 5.x | Server state management |
| **React Router** | 6.30 | Client-side routing |
| **Tailwind CSS** | 3.4 | Utility-first styling |
| **shadcn/ui** | Latest | Component library (Radix-based) |
| **Framer Motion** | 12.x | Animations |
| **Recharts** | 2.15 | Charts and data viz |
| **React Hook Form** | 7.61 | Form state management |
| **Zod** | 3.25 | Schema validation |

### Backend (Supabase)

| Technology | Purpose |
|------------|---------|
| **PostgreSQL 15** | Primary database |
| **PostgREST** | Auto-generated REST API |
| **GoTrue** | Authentication service |
| **Realtime** | WebSocket subscriptions |
| **Storage** | S3-compatible file storage |
| **Edge Functions** | Deno-based serverless functions |
| **pg_graphql** | GraphQL API (optional) |

### Desktop (Electron)

| Technology | Version | Purpose |
|------------|---------|---------|
| **Electron** | 28.x | Desktop wrapper |
| **better-sqlite3** | 11.x | Local encrypted database |
| **serialport** | 12.x | Serial port access (printers) |
| **usb** | 2.11 | USB device access |
| **Drizzle ORM** | 0.38 | Local DB ORM |

### External Integrations

| Service | Purpose |
|---------|---------|
| **KRA eTIMS** | Kenya tax compliance |
| **Safaricom M-Pesa** | Mobile payments |
| **Resend** | Transactional email |
| **Sentry** | Error tracking |
| **Groq/OpenAI** | AI assistant |

---

## Frontend Architecture

### Project Structure

```
src/
├── components/           # Reusable UI components
│   ├── ui/              # shadcn/ui primitives
│   ├── common/          # Shared components
│   ├── forms/           # Form components
│   ├── layout/          # Layout components
│   └── [feature]/       # Feature-specific components
│
├── pages/               # Route page components
│   ├── dashboard/       # Dashboard views
│   ├── pos/             # POS terminal
│   ├── accounting/      # Accounting module
│   ├── inventory/       # Inventory module
│   ├── sales/           # Sales module
│   ├── hr/              # HR module
│   └── settings/        # Settings pages
│
├── hooks/               # Custom React hooks
│   ├── pos/             # POS-specific hooks
│   ├── realtime/        # Realtime subscription hooks
│   └── [feature]/       # Feature hooks
│
├── contexts/            # React contexts
│   ├── AuthContext.tsx  # Authentication state
│   ├── BusinessContext.tsx # Current business
│   └── ThemeContext.tsx # Theme management
│
├── providers/           # Provider components
│   ├── QueryProvider.tsx
│   ├── RealtimeSyncProvider.tsx
│   └── ToastProvider.tsx
│
├── lib/                 # Utility functions
│   ├── utils.ts         # General utilities
│   ├── sentry.ts        # Error tracking
│   └── formatters/      # Data formatters
│
├── routes/              # Route configuration
│   └── lazyRoutes.ts    # Code-split route imports
│
├── integrations/        # External integrations
│   └── supabase/        # Supabase client & types
│
└── test/                # Test utilities
    ├── mocks/           # MSW mock handlers
    └── factories/       # Test data factories
```

### State Management Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     STATE MANAGEMENT LAYERS                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    SERVER STATE                                  │   │
│  │                  (TanStack Query)                                │   │
│  │                                                                  │   │
│  │  • All data from Supabase                                        │   │
│  │  • Automatic caching & invalidation                              │   │
│  │  • Optimistic updates                                            │   │
│  │  • Background refetching                                         │   │
│  │                                                                  │   │
│  │  Example:                                                        │   │
│  │  const { data: invoices } = useQuery({                          │   │
│  │    queryKey: ['invoices', organizationId],                      │   │
│  │    queryFn: () => supabase.from('invoices').select('*')         │   │
│  │  });                                                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    GLOBAL UI STATE                               │   │
│  │                   (React Context)                                │   │
│  │                                                                  │   │
│  │  • AuthContext: Current user, session                            │   │
│  │  • BusinessContext: Selected business, branch                    │   │
│  │  • ThemeContext: Dark/light mode                                 │   │
│  │  • CurrencyContext: Exchange rates, formatting                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    LOCAL COMPONENT STATE                         │   │
│  │                   (useState / useReducer)                        │   │
│  │                                                                  │   │
│  │  • Form inputs                                                   │   │
│  │  • Modal open/close                                              │   │
│  │  • POS cart items                                                │   │
│  │  • Filter selections                                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    OFFLINE STATE                                 │   │
│  │                    (IndexedDB)                                   │   │
│  │                                                                  │   │
│  │  • Queued POS transactions                                       │   │
│  │  • Cached product catalog                                        │   │
│  │  • Local stock counts                                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Code Splitting Strategy

The application uses React.lazy() for route-based code splitting:

```typescript
// src/routes/lazyRoutes.ts
export const LazyPOS = lazy(() => import("@/pages/pos/POSTerminal"));
export const LazyInvoiceList = lazy(() => import("@/pages/sales/InvoiceListPage"));
// ... 40+ lazy-loaded routes
```

**Eager-loaded routes** (always in main bundle):
- Landing page
- Login/Register
- Dashboard
- Core navigation

**Lazy-loaded routes** (loaded on demand):
- POS Terminal
- Invoice pages
- Settings pages
- Reports
- Admin panels

### Realtime Subscriptions

The app uses a **unified subscription pattern** to minimize WebSocket connections:

```typescript
// Before: 17 separate subscriptions
useRealtimeSync('invoices', ...);
useRealtimeSync('products', ...);
useRealtimeSync('payments', ...);
// etc.

// After: 1 unified subscription
useUnifiedRealtimeSync(organizationId, {
  tables: ['invoices', 'products', 'payments', ...],
  onUpdate: (table, payload) => {
    queryClient.invalidateQueries({ queryKey: [table] });
  }
});
```

---

## Backend Architecture

### Edge Functions Overview

All edge functions are located in `supabase/functions/` and run on Deno.

#### Function Categories

| Category | Functions | Purpose |
|----------|-----------|---------|
| **AI** | ai-assistant | Multi-provider AI chat |
| **Payments** | mpesa-stk-push, mpesa-callback, mpesa-c2b-*, mpesa-query | M-Pesa integration |
| **Tax** | etims-*, etims-init, etims-register-item | KRA eTIMS compliance |
| **Documents** | generate-*-pdf, send-*-email | PDF generation & email |
| **Automation** | process-automation, process-scheduled-* | Background jobs |
| **Utilities** | keep-alive, load-sample-data, network-print | System utilities |

#### Authentication Patterns

```typescript
// Pattern 1: JWT Required (most functions)
const authHeader = req.headers.get('Authorization');
const { data: { user }, error } = await supabase.auth.getUser(
  authHeader?.replace('Bearer ', '')
);
if (!user) throw new Error('Unauthorized');

// Pattern 2: Public Webhook (e.g., mpesa-callback)
// No auth check, but validate signature
const signature = req.headers.get('X-Signature');
if (!validateMpesaSignature(body, signature)) {
  throw new Error('Invalid signature');
}

// Pattern 3: Service Role (internal operations)
const supabase = createClient(url, serviceRoleKey);
```

### Database Functions

Key PostgreSQL functions used by the application:

| Function | Purpose |
|----------|---------|
| `process_pos_transaction()` | Atomic POS sale with stock deduction |
| `get_next_invoice_number()` | Thread-safe invoice numbering |
| `check_org_feature_access()` | Plan-based feature gating |
| `is_org_admin()` | Role-based access check |
| `calculate_kenya_paye()` | PAYE tax calculation |
| `calculate_kenya_nhif()` | NHIF deduction calculation |

### Row Level Security (RLS)

Every table has RLS policies enforcing multi-tenant isolation:

```sql
-- Example: invoices table policies
CREATE POLICY "Users can view invoices in their organization" ON invoices
  FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM user_roles 
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

CREATE POLICY "Users can create invoices in their organization" ON invoices
  FOR INSERT WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM user_roles 
      WHERE user_id = auth.uid() AND is_active = true
    )
  );
```

---

## Database Schema

### Entity Relationship Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CORE ENTITIES                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐                                                          │
│  │organizations │──────────────────────────────────────────────────┐       │
│  └──────┬───────┘                                                  │       │
│         │ 1:N                                                      │       │
│         ▼                                                          │       │
│  ┌──────────────┐         ┌──────────────┐         ┌────────────┐ │       │
│  │  businesses  │────────►│   branches   │────────►│ warehouses │ │       │
│  └──────┬───────┘  1:N    └──────────────┘  1:N    └────────────┘ │       │
│         │                                                          │       │
│         │ 1:N                                                      │       │
│         ▼                                                          │       │
│  ┌──────────────┐         ┌──────────────┐         ┌────────────┐ │       │
│  │   contacts   │────────►│   invoices   │────────►│  payments  │ │       │
│  │(customer/vendor)       └──────────────┘  1:N    └────────────┘ │       │
│  └──────────────┘                │                                 │       │
│         │                        │ 1:N                             │       │
│         │                        ▼                                 │       │
│         │                 ┌──────────────┐                        │       │
│         │                 │invoice_items │                        │       │
│         │                 └──────┬───────┘                        │       │
│         │                        │                                 │       │
│         │                        ▼                                 │       │
│         │                 ┌──────────────┐         ┌────────────┐ │       │
│         └────────────────►│   products   │────────►│ categories │ │       │
│                           └──────────────┘  N:1    └────────────┘ │       │
│                                                                    │       │
│  ┌──────────────┐         ┌──────────────┐                        │       │
│  │  user_roles  │────────►│   profiles   │                        │       │
│  └──────────────┘  1:1    └──────────────┘                        │       │
│         │                                                          │       │
│         └──────────────────────────────────────────────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Tables by Module

#### Core/Organization

| Table | Purpose |
|-------|---------|
| `organizations` | Top-level tenant entity |
| `businesses` | Business units within org |
| `branches` | Physical locations |
| `user_roles` | User-org membership & roles |
| `profiles` | User profile data |

#### Sales & Invoicing

| Table | Purpose |
|-------|---------|
| `invoices` | Customer invoices |
| `invoice_items` | Invoice line items |
| `estimates` | Quotations/estimates |
| `proforma_invoices` | Proforma invoices |
| `sales_orders` | Sales orders |
| `delivery_notes` | Delivery documentation |
| `credit_notes` | Credit notes/returns |
| `payments` | Customer payments |

#### Purchasing

| Table | Purpose |
|-------|---------|
| `bills` | Vendor bills |
| `bill_items` | Bill line items |
| `purchase_orders` | Purchase orders |
| `purchase_returns` | Returns to vendors |
| `bill_payments` | Vendor payments |

#### Inventory

| Table | Purpose |
|-------|---------|
| `products` | Product catalog |
| `product_categories` | Category hierarchy |
| `warehouses` | Storage locations |
| `warehouse_stock` | Stock by warehouse |
| `stock_movements` | Stock history |
| `stock_transfers` | Inter-warehouse transfers |

#### POS

| Table | Purpose |
|-------|---------|
| `pos_registers` | Register/terminal config |
| `pos_shifts` | Cashier shifts |
| `pos_transactions` | POS sales |
| `pos_transaction_items` | Sale line items |
| `pos_transaction_payments` | Payment splits |
| `pos_cashiers` | Cashier accounts |
| `pos_sessions` | Active sessions |

#### Accounting

| Table | Purpose |
|-------|---------|
| `accounts` | Chart of accounts |
| `journal_entries` | Journal entries |
| `journal_entry_lines` | Entry line items |
| `bank_accounts` | Bank account records |
| `bank_transactions` | Bank transaction imports |

#### HR & Payroll

| Table | Purpose |
|-------|---------|
| `employees` | Employee records |
| `payroll_runs` | Payroll batches |
| `payroll_items` | Payroll line items |
| `leave_types` | Leave type definitions |
| `leave_requests` | Leave applications |
| `leave_allocations` | Leave balances |

---

## Multi-Tenancy Model

### Hierarchy

```
Organization (Tenant)
├── Subscription Plan
├── Users (via user_roles)
├── Business 1
│   ├── Branch A
│   │   ├── Warehouse 1
│   │   └── POS Register 1
│   └── Branch B
│       ├── Warehouse 2
│       └── POS Register 2
└── Business 2
    └── Branch C
        └── Warehouse 3
```

### Data Isolation

All tables include `organization_id` column with RLS policies ensuring:
- Users only see data from their organizations
- Cross-organization data access is impossible
- Service role bypasses RLS for admin operations

### Business Selection

```typescript
// BusinessContext provides current selection
const { currentBusiness, currentBranch, setCurrentBusiness } = useBusinessContext();

// All queries filter by business
const { data: products } = useQuery({
  queryKey: ['products', currentBusiness?.id],
  queryFn: () => supabase
    .from('products')
    .select('*')
    .eq('business_id', currentBusiness?.id)
});
```

---

## Authentication & Authorization

### Auth Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         AUTHENTICATION FLOW                                 │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. User submits email/password                                            │
│         │                                                                  │
│         ▼                                                                  │
│  2. supabase.auth.signInWithPassword()                                     │
│         │                                                                  │
│         ▼                                                                  │
│  3. GoTrue validates credentials                                           │
│         │                                                                  │
│         ▼                                                                  │
│  4. JWT token returned (stored in localStorage)                            │
│         │                                                                  │
│         ▼                                                                  │
│  5. AuthContext stores user + session                                      │
│         │                                                                  │
│         ▼                                                                  │
│  6. SessionContext fetches user_roles → list of organizations              │
│         │                                                                  │
│         ├─── 0 orgs ──► Redirect to /onboarding (create org)               │
│         ├─── 1 org  ──► Auto-select, go to /dashboard or /my-portal        │
│         └─── 2+ orgs ─► Redirect to /select-organization (Org Selector)    │
│                                                                            │
│  7. Org Selector: User picks which organization to enter                   │
│         │                                                                  │
│         ▼                                                                  │
│  8. switchOrganization(orgId) → Navigate to dashboard/portal               │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Role Hierarchy

| Role | Permissions |
|------|-------------|
| `owner` | Full access, can delete organization |
| `super_admin` | Full access except deletion |
| `admin` | Manage users, settings, all modules |
| `manager` | View reports, manage staff |
| `accountant` | Accounting module access |
| `sales` | Sales and invoicing |
| `cashier` | POS terminal only |
| `viewer` | Read-only access |

### Permission Checks

```typescript
// Hook for checking permissions
const { hasRole, isAdmin, isOwner } = useAuth();

// In components
{isAdmin && <AdminPanel />}
{hasRole('accountant') && <AccountingMenu />}

// Database function check
SELECT has_any_org_role(auth.uid(), org_id, ARRAY['admin', 'owner']::app_role[]);
```

---

## POS System

### Offline-First Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      POS OFFLINE ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     ONLINE MODE                                      │   │
│  │                                                                      │   │
│  │  1. Transaction completed → Supabase insert                         │   │
│  │  2. Stock updated in real-time                                      │   │
│  │  3. eTIMS transmission immediate                                    │   │
│  │  4. Receipt printed with QR code                                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     OFFLINE MODE                                     │   │
│  │                                                                      │   │
│  │  1. Transaction saved to IndexedDB queue                            │   │
│  │  2. Local stock counts decremented                                  │   │
│  │  3. Receipt printed (marked "Pending Sync")                         │   │
│  │  4. Queue shown in UI with sync status                              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     SYNC PROCESS                                     │   │
│  │                                                                      │   │
│  │  1. Connection restored                                             │   │
│  │  2. Process queue in order (FIFO)                                   │   │
│  │  3. Each transaction → process_pos_transaction()                    │   │
│  │  4. On success: remove from queue, update UI                        │   │
│  │  5. On failure: retry with backoff, notify user                     │   │
│  │  6. eTIMS transmission for all synced transactions                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### POS Hooks

| Hook | Purpose |
|------|---------|
| `usePOSSession` | Manage cashier session lifecycle |
| `usePOSCart` | Cart state and calculations |
| `usePOSPayment` | Payment processing |
| `usePOSTransaction` | Transaction creation |
| `usePOSOffline` | Offline queue management |
| `usePOSPrinting` | Receipt printing |
| `useMPesaPayment` | M-Pesa STK push |

### Receipt Printing

```typescript
// ESC/POS command generation
const receiptBytes = buildReceiptData({
  transaction,
  items,
  payments,
  business: currentBusiness,
  etimsInfo: etimsResponse
});

// Web: Browser print dialog
window.print();

// Electron: Direct print
await window.electronAPI.printReceipt({
  type: printerConfig.type, // 'usb' | 'network' | 'serial'
  data: receiptBytes
});
```

---

## Electron Desktop App

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ELECTRON APP STRUCTURE                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        MAIN PROCESS                                    │ │
│  │                        (Node.js)                                       │ │
│  │                                                                        │ │
│  │  • main.js - App lifecycle, window management                         │ │
│  │  • preload.js - Bridge to renderer (contextBridge)                    │ │
│  │  • database/ - SQLite with encryption                                 │ │
│  │  • security/ - Key management, hardware binding                       │ │
│  │                                                                        │ │
│  │  Hardware Access:                                                      │ │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                         │ │
│  │  │ serialport│  │    usb    │  │  network  │                         │ │
│  │  │  (COM/tty)│  │  (direct) │  │  (TCP/IP) │                         │ │
│  │  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘                         │ │
│  │        │              │              │                                │ │
│  │        ▼              ▼              ▼                                │ │
│  │  ┌───────────────────────────────────────────┐                       │ │
│  │  │           Receipt Printers                │                       │ │
│  │  │        Barcode Scanners                   │                       │ │
│  │  │        Cash Drawers                       │                       │ │
│  │  └───────────────────────────────────────────┘                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                       RENDERER PROCESS                                 │ │
│  │                       (React App)                                      │ │
│  │                                                                        │ │
│  │  • Same codebase as web app                                           │ │
│  │  • Uses window.electronAPI for native features                        │ │
│  │  • Detects Electron via window.electronAPI presence                   │ │
│  │                                                                        │ │
│  │  API Examples:                                                         │ │
│  │  window.electronAPI.printReceipt(data)                                │ │
│  │  window.electronAPI.openCashDrawer()                                  │ │
│  │  window.electronAPI.getHardwareId()                                   │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Local Database

The Electron app includes an encrypted SQLite database for:
- Offline transaction queue
- Product catalog cache
- Session state
- Hardware configuration

```typescript
// Encrypted with hardware-bound key
const db = new Database('accrualflow.db', {
  key: deriveKeyFromHardwareId()
});
```

### Building

```bash
cd electron
npm install
npm run build
npm run package:win   # Windows installer
npm run package:mac   # macOS DMG
npm run package:linux # Linux AppImage
```

---

## Edge Functions Reference

### AI & Assistant

#### `ai-assistant`
Multi-provider AI chatbot with context awareness.

```typescript
// Request
POST /functions/v1/ai-assistant
{
  "message": "What's my revenue this month?",
  "context": {
    "organizationId": "uuid",
    "currentPage": "/dashboard"
  }
}

// Response
{
  "response": "Based on your invoices, your revenue this month is KES 1,234,567...",
  "provider": "groq"
}
```

**Secrets:** `GROQ_API_KEY`, `OPENAI_API_KEY` (optional)

---

### Payments (M-Pesa)

#### `mpesa-stk-push`
Initiate M-Pesa STK Push payment request.

```typescript
// Request
POST /functions/v1/mpesa-stk-push
{
  "phone": "254712345678",
  "amount": 1000,
  "reference": "INV-2025-0001",
  "description": "Invoice Payment",
  "organizationId": "uuid"
}

// Response
{
  "success": true,
  "checkoutRequestId": "ws_CO_xxx",
  "merchantRequestId": "xxx"
}
```

**Secrets:** `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, `MPESA_SHORTCODE`

#### `mpesa-callback`
Webhook receiver for M-Pesa payment confirmations.

**Auth:** None (public webhook, validates M-Pesa signature)

#### `mpesa-c2b-register`
Register C2B URL with Safaricom.

#### `mpesa-c2b-validation`
C2B validation webhook.

#### `mpesa-c2b-confirmation`
C2B confirmation webhook.

#### `mpesa-query`
Query M-Pesa transaction status.

---

### Tax Compliance (KRA eTIMS)

#### `etims-init`
Initialize eTIMS integration for an organization.

```typescript
// Request
POST /functions/v1/etims-init
{
  "organizationId": "uuid",
  "businessId": "uuid",
  "tin": "P000000000X",
  "bhfId": "00",
  "deviceSerialNo": "KRAXXX123"
}
```

**Secrets:** `ETIMS_API_URL`, `ETIMS_API_KEY`

#### `etims-transmit-invoice`
Transmit invoice to KRA eTIMS.

```typescript
// Request
POST /functions/v1/etims-transmit-invoice
{
  "invoiceId": "uuid"
}

// Response
{
  "success": true,
  "intrlData": "xxx", // Internal data for QR
  "rcptSign": "xxx",  // Receipt signature
  "sdcId": "xxx",
  "mrcNo": "xxx"      // Machine receipt number
}
```

#### `etims-transmit-pos`
Transmit POS transaction to KRA eTIMS.

#### `etims-transmit-credit-note`
Transmit credit note to KRA eTIMS.

#### `etims-register-item`
Register product/item with KRA.

#### `etims-sync-codes`
Sync classification codes from KRA.

#### `etims-init-vendor`
Initialize eTIMS for vendor (purchase) transactions.

---

### Document Generation

#### `generate-invoice-pdf`
Generate PDF for invoice.

```typescript
// Request
POST /functions/v1/generate-invoice-pdf
{
  "invoiceId": "uuid"
}

// Response
{
  "pdf": "base64...",
  "filename": "INV-2025-0001.pdf"
}
```

#### `generate-estimate-pdf`
Generate PDF for estimate/quotation.

#### `generate-receipt-pdf`
Generate PDF for payment receipt.

---

### Email

#### `send-invoice-email`
Send invoice with PDF attachment to customer.

```typescript
// Request
POST /functions/v1/send-invoice-email
{
  "invoiceId": "uuid",
  "toEmail": "customer@example.com",
  "message": "Please find your invoice attached."
}
```

**Secrets:** `RESEND_API_KEY`

#### `send-receipt-email`
Send payment receipt email.

#### `send-document-email`
Generic document email sender.

#### `send-invitation-email`
Send organization invitation email. Called from Team page, Setup Wizard, Onboarding, App Activate, and Employee Invite flows.

```typescript
// Request
POST /functions/v1/send-invitation-email
{
  "invitationId": "uuid"
}
```

#### `send-admin-email`
Platform admin bulk email sender.

---

### Automation

#### `process-automation`
Execute automated actions defined in `automated_actions` table.

#### `process-scheduled-automations`
Cron job for scheduled automations.

#### `process-recurring-invoices`
Generate invoices from recurring templates.

#### `process-scheduled-reports`
Generate and email scheduled reports.

#### `update-overdue-invoices`
Mark past-due invoices as overdue.

---

### Utilities

#### `keep-alive`
Ping to keep database connection alive.

#### `load-sample-data`
Load demo data for new organizations.

#### `network-print`
Print to network printers via TCP.

```typescript
// Request
POST /functions/v1/network-print
{
  "action": "print",
  "ipAddress": "192.168.1.100",
  "port": 9100,
  "data": [27, 64, ...] // ESC/POS bytes
}
```

#### `accept-invitation`
Accept organization invitation.

#### `validate-invitation`
Validate invitation token.

#### `check-subscription-expiry`
Check and expire trial/subscription periods.

#### `check-inventory-alerts`
Check for low stock and send alerts.

#### `sync-bank-transactions`
Sync transactions from connected banks.

#### `test-bank-connection`
Test bank API connection.

#### `test-payment-provider`
Test payment provider configuration.

#### `submit-demo-request`
Submit demo/contact request.

#### `simulate-transaction`
Simulate POS transaction for testing.

---

## Integration APIs

### KRA eTIMS

**Base URL:** `https://etims-api.kra.go.ke/etims-api/`

| Endpoint | Purpose |
|----------|---------|
| `selectInitInfo` | Initialize device |
| `selectItemClsList` | Get item classifications |
| `saveTrnsPurchaseSales` | Submit invoice/sale |
| `saveTrnsPurchaseSalesOS` | Submit sales return |
| `selectTrnsPurchaseSales` | Query transactions |

### Safaricom M-Pesa

**Base URL:** `https://api.safaricom.co.ke/` (production)

| Endpoint | Purpose |
|----------|---------|
| `oauth/v1/generate` | Get access token |
| `mpesa/stkpush/v1/processrequest` | Initiate STK Push |
| `mpesa/stkpushquery/v1/query` | Query transaction |
| `mpesa/c2b/v1/registerurl` | Register C2B URLs |

### Resend Email

**Base URL:** `https://api.resend.com/`

| Endpoint | Purpose |
|----------|---------|
| `emails` | Send email |

---

## Realtime & Sync

### Subscription Architecture

```typescript
// Unified subscription (new pattern)
const channel = supabase
  .channel(`org-${organizationId}-unified`)
  .on('postgres_changes', 
    { event: '*', schema: 'public', filter: `organization_id=eq.${organizationId}` },
    handleChange
  )
  .subscribe();

// Tables subscribed:
const REALTIME_TABLES = [
  'invoices', 'invoice_items', 'payments',
  'products', 'product_categories',
  'contacts', 'pos_transactions',
  'journal_entries', 'bank_transactions',
  // ... 17 total tables
];
```

### Lazy Subscriptions

For less critical data, lazy subscriptions with auto-cleanup:

```typescript
const { subscribe, unsubscribe } = useLazyRealtimeSync();

// Subscribe when component mounts
useEffect(() => {
  subscribe('audit_logs', handleUpdate);
  return () => unsubscribe('audit_logs');
}, []);
```

---

## Testing Strategy

### Test Structure

```
src/
├── test/
│   ├── setup.ts           # Vitest setup
│   ├── mocks/
│   │   ├── handlers.ts    # MSW request handlers
│   │   └── handlers/
│   │       ├── auth.handlers.ts
│   │       ├── pos.handlers.ts
│   │       └── ...
│   └── factories/
│       ├── user.factory.ts
│       ├── transaction.factory.ts
│       └── ...
├── components/
│   └── [Component]/
│       └── __tests__/
│           └── Component.test.tsx
└── hooks/
    └── [hook]/
        └── __tests__/
            └── useHook.test.ts
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific file
npm test -- src/hooks/pos/__tests__/usePOSTransaction.test.tsx

# Watch mode
npm test -- --watch
```

### Coverage Targets

| Metric | Target |
|--------|--------|
| Statements | 70% |
| Branches | 65% |
| Functions | 70% |
| Lines | 70% |

---

## Deployment Guide

### Web App (Vercel)

The web app deploys automatically via CI/CD:

1. Push to main branch
2. CI/CD pipeline builds and deploys
3. Available at your configured deployment URL

### Supabase

Edge functions deploy automatically with the web app.

For manual deployment:
```bash
npx supabase functions deploy function-name
```

### Docker Deployment

See `docker-compose.yml` and `docker-compose.prod.yml`.

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes

See `k8s/README.md` for complete K8s deployment guide.

```bash
# Deploy to development
kubectl apply -k k8s/overlays/development

# Deploy to production
kubectl apply -k k8s/overlays/production
```

---

## Developer Onboarding

### Prerequisites

- Node.js 20+
- npm 10+
- Git
- VS Code (recommended)
- Docker (optional, for local Supabase)

### Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/accrualflow.git
cd accrualflow

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your Supabase credentials:
# VITE_SUPABASE_URL=https://xxx.supabase.co
# VITE_SUPABASE_PUBLISHABLE_KEY=eyJxxx

# 4. Start development server
npm run dev

# 5. Open http://localhost:5173
```

### Development Workflow

1. **Create feature branch**: `git checkout -b feature/my-feature`
2. **Make changes**
3. **Run tests**: `npm test`
4. **Commit with conventional commits**: `git commit -m "feat: add feature"`
5. **Push and create PR**

### Key Files to Understand

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main app entry, routing |
| `src/contexts/AuthContext.tsx` | Auth state |
| `src/contexts/BusinessContext.tsx` | Business selection |
| `src/integrations/supabase/client.ts` | Supabase client |
| `src/integrations/supabase/types.ts` | Database types |

### Common Tasks

#### Adding a new page

1. Create component in `src/pages/[module]/`
2. Add lazy import in `src/routes/lazyRoutes.ts`
3. Add route in `src/App.tsx`

#### Adding a database table

1. Create migration in Supabase dashboard
2. Run migration
3. Types auto-generate in `src/integrations/supabase/types.ts`

#### Adding an edge function

1. Create folder in `supabase/functions/[name]/`
2. Create `index.ts` with handler
3. Update `supabase/config.toml`
4. Deploy via CI/CD pipeline or manually using the Supabase CLI

---

## Troubleshooting

### Common Issues

#### "No user session found"
- Check that you're logged in
- Clear localStorage and re-login
- Check Supabase auth configuration

#### "Permission denied" on database query
- Check RLS policies
- Verify user has correct role
- Check `organization_id` filter

#### POS transaction fails
- Check network connectivity
- Verify stock availability
- Check shift is open
- Review `pos_transactions` error logs

#### M-Pesa STK Push not working
- Verify phone number format (254...)
- Check M-Pesa credentials
- Verify callback URL is accessible
- Check Safaricom sandbox/production mode

#### eTIMS transmission fails
- Verify device is initialized
- Check TIN and BHF ID
- Verify item codes are registered
- Check KRA system status

### Debug Tools

```typescript
// Enable Supabase query logging
localStorage.setItem('supabase.debug', 'true');

// Check auth state
const { data: session } = await supabase.auth.getSession();
console.log(session);

// Check realtime subscriptions
const channels = supabase.getChannels();
console.log(channels);
```

### Getting Help

1. Check console logs
2. Check Supabase logs (Dashboard → Logs)
3. Check Edge Function logs
4. Search existing issues
5. Create new issue with:
   - Steps to reproduce
   - Expected vs actual behavior
   - Console logs
   - Network requests

---

## Security Considerations

### Data Protection

- All data encrypted in transit (TLS 1.3)
- RLS enforces tenant isolation
- Sensitive data never logged
- PII redacted in error reports (Sentry)

### Authentication

- JWT tokens expire after 1 hour
- Refresh tokens rotate on use
- Session invalidation on password change
- Rate limiting on auth endpoints

### API Security

- All edge functions validate JWT (except webhooks)
- Webhook endpoints validate signatures
- CORS configured for allowed origins
- Input validation with Zod

### Secrets Management

- Secrets stored in Supabase vault
- Never committed to repository
- Rotated regularly
- Access logged

---

## Appendix

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase anon key |
| `SENTRY_DSN` | No | Sentry error tracking DSN |

### Supabase Secrets (Edge Functions)

| Secret | Purpose |
|--------|---------|
| `GROQ_API_KEY` | Groq AI provider |
| `OPENAI_API_KEY` | OpenAI fallback |
| `MPESA_CONSUMER_KEY` | M-Pesa API |
| `MPESA_CONSUMER_SECRET` | M-Pesa API |
| `MPESA_PASSKEY` | M-Pesa STK Push |
| `MPESA_SHORTCODE` | Business shortcode |
| `RESEND_API_KEY` | Email sending |
| `SENTRY_DSN` | Error tracking |

### Useful Links

- [Supabase Documentation](https://supabase.com/docs)
- [TanStack Query](https://tanstack.com/query)
- [shadcn/ui](https://ui.shadcn.com)
- [KRA eTIMS Developer Portal](https://etims.kra.go.ke)
- [Safaricom M-Pesa API](https://developer.safaricom.co.ke)

---

*This document is maintained by the AccrualFlow Engineering Team. For updates, submit a PR to `docs/ARCHITECTURE.md`.*
