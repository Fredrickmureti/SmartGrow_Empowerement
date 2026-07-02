<div align="center">

# 📊 FinanceFlow

### Enterprise-Grade ERP & Financial Management Platform

A comprehensive, multi-tenant business management system built for enterprises of all sizes. Manage accounting, invoicing, inventory, CRM, HR, payroll, POS, and more — all in one unified platform.

[![React](https://img.shields.io/badge/React-18.3-61DAFB?style=for-the-badge&logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3FCF8E?style=for-the-badge&logo=supabase)](https://supabase.com)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-06B6D4?style=for-the-badge&logo=tailwindcss)](https://tailwindcss.com)
[![KRA eTIMS](https://img.shields.io/badge/KRA-eTIMS%20Certified-FF6B00?style=for-the-badge)](https://etims.kra.go.ke)

</div>

---

## 📋 Table of Contents

- [Features](#-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Configuration](#-configuration)
- [Database Schema](#-database-schema)
- [Edge Functions](#-edge-functions)
- [eTIMS Integration](#-etims-integration)
- [Security](#-security)
- [Desktop App (Electron)](#-desktop-app-electron)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

### 💰 Financial Management

| Feature | Description |
|---------|-------------|
| **Invoicing** | Create, send, and track professional invoices with customizable templates |
| **Estimates & Quotes** | Generate estimates and convert to invoices with one click |
| **Proforma Invoices** | Pre-payment invoices for advance billing scenarios |
| **Bills & Expenses** | Track vendor bills and categorize business expenses |
| **Credit Notes** | Issue refunds and credits with automatic balance tracking |
| **Recurring Invoices** | Automate subscription billing with flexible schedules |
| **Customer Payments** | Record and track payments with receipt generation |
| **Customer Statements** | Generate and send periodic account statements |
| **Vendor Payments** | Track payments to vendors with reconciliation support |

### 📦 Inventory & Warehouse Management

| Feature | Description |
|---------|-------------|
| **Product Catalog** | Manage products/services with SKU, barcode, and image support |
| **Multi-Warehouse** | Track stock across multiple warehouse locations |
| **Stock Movements** | Automatic stock in/out tracking on transactions |
| **Stock Adjustments** | Manual inventory corrections with approval workflow |
| **Reorder Rules** | Automated low-stock alerts and reorder suggestions |
| **Price Lists** | Multiple pricing tiers with customer-specific pricing |
| **ABC Analysis** | Classify inventory by value contribution |
| **Batch/Serial Tracking** | Track items by batch or serial numbers |

### 🛒 Sales Management

| Feature | Description |
|---------|-------------|
| **Sales Orders** | Create orders with approval workflows and status tracking |
| **Delivery Notes** | Generate delivery notes from sales orders |
| **Sales Returns** | Process customer returns with inventory updates |
| **Backorder Management** | Track and fulfill backorders automatically |
| **Quick Conversions** | Convert Leads → Estimates → Orders → Invoices seamlessly |

### 🛍️ Purchasing

| Feature | Description |
|---------|-------------|
| **Purchase Orders** | Manage vendor orders with approval workflows |
| **Purchase Returns** | Process returns to vendors with credit tracking |
| **Vendor Management** | Maintain vendor profiles with payment terms |
| **GRN Processing** | Goods received note generation and tracking |

### 🏦 Banking & Reconciliation

| Feature | Description |
|---------|-------------|
| **Multi-Bank Support** | Connect and manage multiple bank accounts |
| **Transaction Sync** | Automatic bank transaction import |
| **Bank Reconciliation** | Match transactions with invoices/expenses |
| **Transaction Rules** | Automated categorization rules |
| **Bank Feeds** | Real-time transaction feeds from connected banks |

### 🌍 Multi-Currency System

| Feature | Description |
|---------|-------------|
| **30+ Currencies** | USD, EUR, GBP, KES, UGX, NGN, ZAR, INR, JPY, and more |
| **Dynamic Conversion** | Real-time conversion with configurable exchange rates |
| **Custom Rates** | Configure bank-specific exchange rates |
| **Currency Toggle** | View dashboard in any currency instantly |
| **Automatic Reverse Rates** | Bidirectional exchange rate creation |

### 📚 Accounting

| Feature | Description |
|---------|-------------|
| **Chart of Accounts** | Full double-entry accounting with hierarchy |
| **Journal Entries** | Create, post, void, and reverse entries |
| **Budgets** | Create and track budgets with variance analysis |
| **Fixed Assets** | Asset management with depreciation tracking |
| **Tax Management** | Multiple tax rates and tax groups |
| **Payment Terms** | Customizable payment terms for documents |

### 👥 CRM (Customer Relationship Management)

| Feature | Description |
|---------|-------------|
| **Lead Pipeline** | Visual Kanban board for lead management |
| **Lead Stages** | Customizable pipeline stages |
| **Lead Scoring** | Automatic lead scoring and prioritization |
| **Lead Conversion** | Convert leads to Contacts, Estimates, or Sales Orders |
| **Activity Tracking** | Log calls, meetings, and interactions |
| **Contact Management** | Unified customer and vendor database |

### 👨‍💼 Human Resources

| Feature | Description |
|---------|-------------|
| **Employee Management** | Complete employee profiles with documents |
| **Department Structure** | Hierarchical department organization |
| **Leave Management** | Leave requests, approvals, and balance tracking |
| **Timesheets** | Time tracking with project allocation |
| **Payroll** | Salary processing with statutory deductions |
| **Employee Self-Service** | Employee portal for HR requests |

### 📊 Project Management

| Feature | Description |
|---------|-------------|
| **Project Tracking** | Create and manage projects with timelines |
| **Task Management** | Break down projects into manageable tasks |
| **Time Allocation** | Track time spent per project/task |
| **Project Billing** | Bill clients based on project time |
| **Resource Planning** | Allocate team members to projects |

### 🛍️ Enterprise Point of Sale (POS)

| Feature | Description |
|---------|-------------|
| **Multi-Register** | Manage multiple POS registers per location |
| **Shift Management** | Open/close shifts with cash counting |
| **Offline-First** | Continue sales during internet outages (IndexedDB) |
| **Transaction Queue** | Automatic sync when connectivity restored |
| **Barcode Scanning** | Built-in barcode scanner support |
| **Receipt Printing** | ESC/POS thermal printer integration |
| **Cash Drawer Control** | Hardware cash drawer support |
| **Scale Integration** | Weight-based pricing (Toledo, CAS, generic) |
| **Held Transactions** | Park and retrieve transactions |
| **Quick Returns** | Process returns at the register |
| **Customer Lookup** | Attach customers to transactions |
| **Discount Management** | Item, transaction, and promotional discounts |
| **M-Pesa Integration** | Mobile money payments (Kenya) |
| **Age Verification** | Compliance for age-restricted products |
| **Loyalty Programs** | Points-based loyalty with tier management |
| **Customer Display** | Secondary screen for customer-facing display |
| **Cashier Performance** | Track sales by cashier with analytics |
| **eTIMS POS Transmission** | Real-time KRA tax compliance for POS |

### ⚙️ Studio (Automation & Customization)

| Feature | Description |
|---------|-------------|
| **Custom Fields** | Add custom fields to any entity |
| **Automation Builder** | Create Odoo-style automated workflows |
| **Automation Templates** | Pre-built automation templates (15+ included) |
| **Saved Views** | Save and share custom list views |
| **Form Designer** | Customize form layouts per entity |
| **Report Templates** | Design custom report templates |
| **Scheduled Reports** | Automated report generation and email delivery |
| **Trigger Types** | On Create, On Update, On Delete, Scheduled |
| **Action Types** | Email, Field Update, Webhook, Create Record |

### 🇰🇪 KRA eTIMS Integration (Kenya Revenue Authority)

| Feature | Description |
|---------|-------------|
| **Device Registration** | Automatic OSCU device initialization with KRA |
| **Communication Key Exchange** | Secure key exchange with KRA servers |
| **Invoice Transmission** | Real-time invoice transmission to KRA |
| **Credit Note Transmission** | Transmit credit notes with original invoice reference |
| **POS Transmission** | Automatic POS transaction transmission |
| **Standard Codes Sync** | Synchronize KRA standard codes (tax types, units, etc.) |
| **Item Registration** | Register products with eTIMS |
| **QR Code Generation** | KRA-compliant verification QR codes on receipts |
| **Control Unit Number** | Automatic CU number generation |
| **Transmission Logging** | Complete audit trail of all eTIMS transmissions |
| **Retry Mechanism** | Automatic retry for failed transmissions |
| **Sandbox & Production** | Support for both KRA environments |

### 📈 Reporting & Analytics

| Feature | Description |
|---------|-------------|
| **Dashboard** | Real-time financial metrics and KPIs |
| **Financial Reports** | Balance sheet, P&L, trial balance, cash flow |
| **Sales Reports** | Sales analytics with trends and comparisons |
| **Tax Reports** | VAT/GST reporting and summaries |
| **Stock Reports** | Inventory valuation and movements |
| **Management Reports** | Executive dashboards and KPIs |
| **POS Reports** | Register, cashier, and hourly analytics |
| **Fraud Detection** | Identify anomalies and patterns |
| **Business Intelligence** | Advanced analytics dashboard |
| **Export Options** | CSV, PDF, and Excel export capabilities |
| **Scheduled Reports** | Automated report generation (daily/weekly/monthly) |

### 🖥️ Electron Desktop App

| Feature | Description |
|---------|-------------|
| **Native Hardware** | Direct USB/Serial access for printers, scales |
| **Cross-Platform** | Windows, macOS, and Linux support |
| **Offline Capable** | Full functionality without internet |
| **Customer Display** | Native secondary display support |
| **Kiosk Mode** | Lock-down mode for dedicated terminals |

### 👥 Organization & Team

| Feature | Description |
|---------|-------------|
| **Multi-Organization** | Manage multiple organizations from one account |
| **Multi-Business** | Multiple businesses per organization |
| **Branches** | Manage branch/location hierarchy |
| **Role-Based Access** | Owner, Admin, Accountant, Staff, Viewer roles |
| **Team Invitations** | Email-based team member invitations |
| **Audit Logging** | Comprehensive audit trails |
| **Onboarding Wizard** | Guided setup for new organizations |

### 💳 Subscription & Billing (Platform Admin)

| Feature | Description |
|---------|-------------|
| **Subscription Plans** | Configure multiple subscription tiers |
| **Feature Gating** | Granular feature access per plan |
| **Usage Limits** | Enforce limits on resources |
| **Trial Management** | Configure trial periods |
| **Organization Management** | Suspend/unsuspend organizations |

### 🤖 AI-Powered Features

| Feature | Description |
|---------|-------------|
| **AI Assistant** | Chat-based financial insights and help |
| **Multi-Provider** | Groq, OpenAI, Gemini, OpenRouter support |
| **Automatic Fallback** | Seamless failover between providers |
| **Expense Categorization** | Automatic expense category suggestions |
| **Invoice Analysis** | AI-powered invoice insights |
| **Email Writing** | AI-assisted document email composition |

### 📧 Email & Communication

| Feature | Description |
|---------|-------------|
| **Document Emailing** | Send invoices, estimates, receipts via email |
| **PDF Attachments** | Automatic PDF generation and attachment |
| **Email Templates** | Professional document email templates |
| **Team Invitations** | Email-based onboarding |
| **Admin Email Center** | Platform-wide email management |

### 🔐 Security & Authentication

| Feature | Description |
|---------|-------------|
| **Secure Auth** | Email/password with password reset flow |
| **Row Level Security** | Data isolation between organizations |
| **Protected Routes** | Role-based access control |
| **Subscription Gating** | Block access for suspended accounts |
| **Feature Gating** | Plan-based feature enforcement |
| **Admin Portal** | Platform administration dashboard |

### 🔌 Integrations

| Integration | Description |
|-------------|-------------|
| **KRA eTIMS** | Kenya Revenue Authority tax compliance |
| **Stripe** | Payment gateway for online payments |
| **M-Pesa STK Push** | Mobile money payments (Kenya) |
| **M-Pesa C2B** | Customer-to-business payments |
| **Resend** | Transactional email delivery |
| **Bank Providers** | Multiple banking provider support |
| **Hardware** | ESC/POS printers, cash drawers, scales |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React + Vite)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  Pages                    │  Components              │  Hooks               │
│  ├── Dashboard            │  ├── Layout              │  ├── useInvoices     │
│  ├── Invoices             │  ├── Auth                │  ├── useExpenses     │
│  ├── Expenses             │  ├── Banking             │  ├── useSalesOrders  │
│  ├── Bills                │  ├── Dashboard           │  ├── usePurchaseOrders│
│  ├── Estimates            │  ├── CRM                 │  ├── useInventory    │
│  ├── SalesOrders          │  ├── POS                 │  ├── useLeads        │
│  ├── PurchaseOrders       │  ├── Studio              │  ├── useEmployees    │
│  ├── Products             │  ├── HR                  │  ├── usePayroll      │
│  ├── Inventory            │  ├── AI                  │  ├── useProjects     │
│  ├── Banking              │  ├── Settings            │  ├── useTimesheets   │
│  ├── CRM/Pipeline         │  ├── eTIMS               │  ├── useTaxCompliance│
│  ├── Employees            │  └── UI (shadcn)         │  └── useAutomations  │
│  ├── Payroll              │                          │                      │
│  ├── Projects             │                          │                      │
│  ├── Timesheets           │                          │                      │
│  ├── Leave                │                          │                      │
│  ├── POS/*                │                          │                      │
│  ├── Studio               │                          │                      │
│  ├── Reports/*            │                          │                      │
│  └── Admin/*              │                          │                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                          BACKEND (Supabase)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  Database (PostgreSQL)         │  Edge Functions              │  Storage    │
│  ├── Organizations             │  ├── ai-assistant            │  ├── receipts│
│  ├── Businesses/Branches       │  ├── generate-*-pdf (3)      │  ├── logos   │
│  ├── Invoices/Items            │  ├── send-*-email (5)        │  ├── products│
│  ├── Sales/Purchase Orders     │  ├── mpesa-* (6)             │  └── docs    │
│  ├── Leads/Contacts            │  ├── etims-* (7)             │             │
│  ├── Employees/Departments     │  ├── sync-bank-transactions  │  Auth       │
│  ├── Leave/Timesheets          │  ├── process-automation      │  ├── Email  │
│  ├── Projects/Tasks            │  ├── process-scheduled-*     │  └── Roles  │
│  ├── Products/Inventory        │  └── accept-invitation       │             │
│  ├── Tax Compliance Configs    │                              │             │
│  ├── eTIMS Transmission Logs   │                              │             │
│  ├── Automated Actions         │                              │             │
│  └── 100+ Tables               │                              │             │
├─────────────────────────────────────────────────────────────────────────────┤
│                      DESKTOP (Electron - Optional)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  ├── Native USB Printing       │  ├── Customer Display        │             │
│  ├── Serial Scale Integration  │  ├── Kiosk Mode              │             │
│  └── Cash Drawer Control       │  └── Window Management       │             │
├─────────────────────────────────────────────────────────────────────────────┤
│                      EXTERNAL INTEGRATIONS                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  ├── KRA eTIMS API             │  ├── M-Pesa Daraja API       │             │
│  ├── Bank Open Banking APIs    │  ├── Resend Email API        │             │
│  └── AI Providers (Multi)      │  └── Stripe Payment API      │             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack

| Category | Technology |
|----------|------------|
| **Framework** | React 18.3 with Vite |
| **Language** | TypeScript 5.0 |
| **Styling** | Tailwind CSS + shadcn/ui |
| **State Management** | TanStack Query (React Query) v5 |
| **Routing** | React Router v6 |
| **Backend** | Supabase (PostgreSQL + Auth + Edge Functions + Storage) |
| **Charts** | Recharts |
| **Forms** | React Hook Form + Zod |
| **Animations** | Framer Motion |
| **Date Handling** | date-fns |
| **Icons** | Lucide React |
| **Testing** | Vitest + Testing Library |
| **PDF Generation** | Server-side Edge Functions |
| **Desktop** | Electron (optional) |

---

## 📁 Project Structure

```
├── electron/                    # Electron desktop app
│   ├── main.ts                  # Main process
│   ├── preload.ts               # Context bridge API
│   └── package.json             # Electron dependencies
├── src/
│   ├── components/
│   │   ├── admin/               # Platform admin components
│   │   ├── ai/                  # AI assistant components
│   │   ├── auth/                # Authentication components
│   │   ├── banking/             # Banking & reconciliation
│   │   ├── common/              # Shared components
│   │   ├── crm/                 # CRM components
│   │   ├── dashboard/           # Dashboard widgets
│   │   ├── email/               # Email components
│   │   ├── estimates/           # Estimate components
│   │   ├── expenses/            # Expense components
│   │   ├── hr/                  # HR components
│   │   ├── inventory/           # Inventory components
│   │   ├── invoices/            # Invoice components
│   │   ├── layout/              # Layout components
│   │   ├── onboarding/          # Onboarding components
│   │   ├── organization/        # Organization management
│   │   ├── payments/            # Payment components
│   │   ├── pos/                 # POS components (incl. eTIMS)
│   │   ├── products/            # Product components
│   │   ├── projects/            # Project components
│   │   ├── reports/             # Report components
│   │   ├── sales/               # Sales order components
│   │   ├── settings/            # Settings components (incl. TaxCompliance)
│   │   ├── studio/              # Studio/automation components
│   │   ├── theme/               # Theme components
│   │   └── ui/                  # shadcn/ui components
│   ├── contexts/
│   │   ├── AuthContext.tsx      # Authentication context
│   │   └── CurrencyContext.tsx  # Currency context
│   ├── hooks/
│   │   ├── crm/                 # CRM hooks (useLeads, etc.)
│   │   ├── leave/               # Leave management hooks
│   │   ├── pos/                 # POS hooks (30+ specialized)
│   │   ├── projects/            # Project hooks
│   │   ├── timesheets/          # Timesheet hooks
│   │   ├── useTaxCompliance.ts  # eTIMS tax compliance hook
│   │   └── *.ts                 # 80+ feature hooks
│   ├── integrations/
│   │   └── supabase/
│   │       ├── client.ts        # Supabase client
│   │       └── types.ts         # Generated types
│   ├── lib/
│   │   ├── utils.ts             # Utility functions
│   │   ├── permissions.ts       # Permission utilities
│   │   └── countryCurrency.ts   # Country currency mapping
│   ├── pages/
│   │   ├── admin/               # Platform admin pages
│   │   ├── crm/                 # CRM pages
│   │   ├── leave/               # Leave management pages
│   │   ├── pos/                 # POS pages
│   │   ├── projects/            # Project pages
│   │   ├── reports/             # Report pages
│   │   ├── timesheets/          # Timesheet pages
│   │   └── *.tsx                # 50+ feature pages
│   ├── services/
│   │   └── hardware/            # Hardware integration services
│   └── data/
│       └── automationTemplates.ts # Pre-built automation templates
├── supabase/
│   ├── config.toml              # Supabase configuration
│   ├── migrations/              # Database migrations (100+)
│   └── functions/               # 40+ Edge functions
├── docs/
│   └── KRA_ETIMS_VENDOR_CERTIFICATION.md  # eTIMS certification document
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm (or bun)
- Supabase account and project
- Git

### Installation

```bash
# Clone the repository
git clone <YOUR_GIT_URL>

# Navigate to project directory
cd <YOUR_PROJECT_NAME>

# Install dependencies
npm install
# or
bun install

# Start development server
npm run dev
# or
bun dev
```

The app will be available at `http://localhost:5173`

### Environment Configuration

Create a `.env` file in the root directory:

```env
# Supabase Configuration (Required)
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

---

## ⚙️ Configuration

### Supabase Setup

1. **Create a Supabase Project**
   - Go to [supabase.com](https://supabase.com) and create a new project
   - Note your project URL and anon key

2. **Run Database Migrations**
   ```bash
   npm install -g supabase
   supabase link --project-ref your-project-id
   supabase db push
   ```

3. **Deploy Edge Functions**
   ```bash
   supabase functions deploy
   ```

4. **Configure Edge Function Secrets**
   Go to Supabase Dashboard → Settings → Edge Functions and add:
   
   | Secret | Description |
   |--------|-------------|
   | `RESEND_API_KEY` | Email sending (from resend.com) |
   | `GROQ_API_KEY` | AI provider (optional) |
   | `OPENAI_API_KEY` | AI provider (optional) |
   | `GOOGLE_API_KEY` | AI provider (optional) |
   | `MPESA_CONSUMER_KEY` | M-Pesa integration (optional) |
   | `MPESA_CONSUMER_SECRET` | M-Pesa integration (optional) |

5. **Enable Authentication**
   - Go to Authentication → Providers
   - Enable Email provider
   - Configure email templates

### Currency Configuration

1. Navigate to **Settings** → **Currency**
2. Select your organization's base currency
3. Add exchange rates for multi-currency support
4. Enable "Also create reverse rate" for bidirectional rates

### POS Setup

1. Navigate to **Settings** → **POS**
2. Create registers for each terminal
3. Configure receipt templates
4. Connect hardware (printers, scales, cash drawers)
5. Set up payment methods including M-Pesa if applicable
6. Enable eTIMS for tax compliance (Kenya)

---

## 🇰🇪 eTIMS Integration

FinanceFlow provides comprehensive integration with Kenya Revenue Authority's electronic Tax Invoice Management System (eTIMS).

### Overview

The eTIMS integration enables businesses to:
- Transmit invoices, credit notes, and POS transactions to KRA in real-time
- Generate KRA-compliant receipts with QR codes
- Maintain full audit trails for tax compliance

### Setup Process

1. **Prerequisites**
   - Valid KRA PIN
   - Registered business on iTax portal
   - eTIMS OSCU registration on [etims.kra.go.ke](https://etims.kra.go.ke)

2. **Configuration Steps**
   - Navigate to **Settings** → **Tax Compliance**
   - Enter your KRA PIN and Branch ID (BHF ID)
   - Click **Initialize Device** to register with KRA
   - Sync standard codes for tax types, units, etc.
   - Enable eTIMS for your organization

3. **Automatic Transmission**
   - Invoices are automatically transmitted when created/sent
   - Credit notes include original invoice reference
   - POS transactions can be configured for auto-transmission
   - Failed transmissions are queued for automatic retry

### Edge Functions

| Function | Description |
|----------|-------------|
| `etims-init` | Initialize OSCU device with KRA |
| `etims-init-vendor` | Platform vendor initialization |
| `etims-register-item` | Register products with eTIMS |
| `etims-sync-codes` | Sync KRA standard codes |
| `etims-transmit-invoice` | Transmit invoices to KRA |
| `etims-transmit-credit-note` | Transmit credit notes |
| `etims-transmit-pos` | Transmit POS transactions |

### Compliance Features

- **CU Invoice Number**: Auto-generated control unit number
- **QR Code**: KRA verification QR code on all documents
- **Digital Signature**: Cryptographic signature per KRA specs
- **Transmission Logging**: Complete audit trail
- **Retry Mechanism**: Automatic retry for failed transmissions

For detailed vendor certification documentation, see [docs/KRA_ETIMS_VENDOR_CERTIFICATION.md](docs/KRA_ETIMS_VENDOR_CERTIFICATION.md).

---

## 📊 Database Schema

### Core Tables (100+)

| Category | Tables |
|----------|--------|
| **Organization** | `organizations`, `businesses`, `branches`, `user_roles`, `profiles` |
| **Contacts** | `contacts`, `customer_credits`, `price_lists`, `price_list_items` |
| **Sales** | `invoices`, `estimates`, `proforma_invoices`, `sales_orders`, `delivery_notes`, `sales_returns`, `credit_notes` |
| **Purchasing** | `bills`, `purchase_orders`, `purchase_returns`, `bill_payments` |
| **Inventory** | `products`, `warehouses`, `stock_movements`, `stock_adjustments`, `backorders` |
| **Accounting** | `accounts`, `journal_entries`, `budgets`, `fixed_assets`, `tax_rates` |
| **Banking** | `bank_accounts`, `bank_transactions`, `transaction_rules` |
| **HR** | `employees`, `departments`, `leave_requests`, `timesheets`, `payroll_runs` |
| **CRM** | `leads`, `lead_stages`, `activities` |
| **Projects** | `projects`, `project_tasks`, `project_time_entries` |
| **POS** | `pos_registers`, `pos_shifts`, `pos_transactions`, `pos_held_transactions`, `pos_settings` |
| **Automation** | `automated_actions`, `automated_action_steps`, `automated_action_logs`, `scheduled_reports` |
| **Tax Compliance** | `tax_compliance_configs`, `etims_transmission_logs`, `etims_standard_codes` |
| **Platform** | `subscription_plans`, `ai_providers`, `platform_settings` |

---

## 🔧 Edge Functions

| Function | Description |
|----------|-------------|
| `ai-assistant` | AI chat assistant with multi-provider support |
| `generate-invoice-pdf` | Generate PDF invoices |
| `generate-estimate-pdf` | Generate PDF estimates |
| `generate-receipt-pdf` | Generate PDF receipts |
| `send-invoice-email` | Send invoice via email |
| `send-document-email` | Send generic documents via email |
| `send-invitation-email` | Send team invitations |
| `send-admin-email` | Admin email capabilities |
| `send-receipt-email` | Send receipts via email |
| `accept-invitation` | Process team invitation acceptance |
| `validate-invitation` | Validate invitation tokens |
| `sync-bank-transactions` | Sync bank transactions |
| `test-bank-connection` | Test bank provider connection |
| `simulate-transaction` | Simulate bank transactions (dev) |
| `mpesa-stk-push` | Initiate M-Pesa STK Push |
| `mpesa-callback` | Handle M-Pesa callbacks |
| `mpesa-query` | Query M-Pesa transaction status |
| `mpesa-c2b-register` | Register M-Pesa C2B URLs |
| `mpesa-c2b-validation` | Validate C2B transactions |
| `mpesa-c2b-confirmation` | Confirm C2B transactions |
| `mpesa-simulate-callback` | Simulate M-Pesa callbacks (dev) |
| `etims-init` | Initialize eTIMS device |
| `etims-init-vendor` | Initialize vendor for eTIMS |
| `etims-register-item` | Register items with eTIMS |
| `etims-sync-codes` | Sync eTIMS standard codes |
| `etims-transmit-invoice` | Transmit invoices to KRA |
| `etims-transmit-credit-note` | Transmit credit notes to KRA |
| `etims-transmit-pos` | Transmit POS transactions to KRA |
| `process-automation` | Execute automated actions |
| `process-scheduled-automations` | Run scheduled automations |
| `process-scheduled-reports` | Generate and email scheduled reports |
| `process-recurring-invoices` | Generate recurring invoices |
| `update-overdue-invoices` | Update invoice statuses |
| `check-inventory-alerts` | Check and send inventory alerts |
| `check-subscription-expiry` | Check subscription status |
| `network-print` | Network printing support |
| `load-sample-data` | Load demo/sample data |
| `submit-demo-request` | Handle demo requests |
| `keep-alive` | Keep functions warm |

---

## 🔒 Security

| Feature | Implementation |
|---------|----------------|
| **Row Level Security** | All tables protected with organization-scoped RLS policies |
| **Role-Based Access** | Owner, Admin, Accountant, Staff, Viewer permission levels |
| **Secure Authentication** | Supabase Auth with bcrypt password hashing |
| **Protected API Routes** | JWT validation on all edge functions |
| **Audit Logging** | Comprehensive change tracking with user attribution |
| **Data Isolation** | Complete tenant separation at database level |
| **Session Management** | Secure session handling with automatic refresh |
| **Subscription Enforcement** | Route protection based on subscription status |
| **eTIMS Security** | Encrypted communication keys, secure transmission |

---

## 🖥️ Desktop App (Electron)

The Electron wrapper provides native hardware access for POS terminals.

### Features

- **Native USB Printing** — Direct ESC/POS printer access
- **Serial Scale Integration** — Real-time weight reading
- **Cash Drawer Control** — Open drawer via printer port
- **Customer Display** — Secondary screen support
- **Kiosk Mode** — Lock-down mode for dedicated terminals

### Setup

```bash
cd electron
npm install
npm run build
npm start
```

### Packaging

```bash
npm run package         # All platforms
npm run package:win     # Windows only
npm run package:mac     # macOS only
npm run package:linux   # Linux only
```

See [electron/README.md](electron/README.md) for detailed hardware integration documentation.

---

## 🧪 Testing

```bash
# Run all tests
npm run test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm run test -- src/components/MyComponent.test.tsx
```

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Code Style

- Use TypeScript for all new code
- Follow existing patterns for hooks and components
- Use semantic design tokens from the design system
- Add tests for new features
- Update documentation as needed

---

## 📄 License

This project is proprietary software. All rights reserved.

---

<div align="center">

**Built by [Fredrick Mureti](https://mureti.dev)**

</div>
