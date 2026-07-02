import { 
  BookOpen, 
  Zap, 
  FileText, 
  CreditCard, 
  Building2, 
  ShoppingCart,
  BarChart3,
  Users,
  Settings,
  Shield,
  Globe,
  Truck,
  Package,
  Calculator,
  Wallet,
  Receipt,
  RefreshCw,
  Smartphone,
  Database,
  HelpCircle,
  Briefcase,
  Calendar,
  FolderOpen,
  
  Grid3X3,
  Bot,
  Clock,
  Target,
  LucideIcon
} from "lucide-react";

export interface DocSection {
  id: string;
  title: string;
  icon: LucideIcon;
  content: string;
}

export const docSections: DocSection[] = [
  {
    id: "overview",
    title: "Platform Overview",
    icon: BookOpen,
    content: `
# Platform Overview

AccrualFlow is a comprehensive, enterprise-grade invoicing, accounting, and business management platform designed for modern businesses operating in today's global economy. Whether you're a freelancer managing a handful of clients, a small business scaling operations, or a growing enterprise with complex multi-entity requirements, AccrualFlow provides the complete business management toolkit you need.

## Why AccrualFlow?

AccrualFlow was built from the ground up to address the real challenges faced by businesses in emerging markets, while incorporating global best practices in financial management. Our platform uniquely combines:

- **Regulatory Compliance**: Built-in support for tax authorities including Kenya's eTIMS, ensuring you stay compliant without extra effort
- **Multi-Currency Excellence**: Native support for multiple currencies with real-time exchange rates and automatic conversion
- **Offline-First Design**: Critical features like POS continue working without internet, syncing automatically when connected
- **Enterprise Security**: Bank-grade encryption, role-based access control, and comprehensive audit trails
- **All-in-One Platform**: From invoicing to HR, CRM to project management - everything in one integrated system

## Key Capabilities

### Financial Management
- **Invoicing & Billing**: Create professional invoices with customizable templates, automated reminders, and multiple payment options
- **Expense Management**: Track expenses with receipt scanning, category management, and approval workflows
- **Bills & Payables**: Manage vendor bills, schedule payments, and maintain healthy supplier relationships
- **Credit Notes**: Issue credit notes for returns and adjustments with full audit trails
- **Customer Statements**: Generate and send periodic statements to keep customers informed
- **Multiple Payment Methods**: Configure bank accounts, mobile money (M-Pesa), PayPal, and more

### Inventory & Products
- **Product Catalog**: Comprehensive product management with variants, pricing tiers, and images
- **Stock Tracking**: Real-time inventory levels across multiple warehouses and locations
- **Purchase Orders**: Streamlined procurement with vendor management and order tracking
- **Stock Valuation**: Multiple costing methods including FIFO, LIFO, and weighted average

### Sales Operations
- **Sales Orders**: Full order management from quote to delivery
- **Delivery Notes**: Track shipments and deliveries with customer signatures
- **Proforma Invoices**: Professional quotations that convert to invoices with one click
- **Sales Returns**: Manage product returns with restocking and credit note generation

### Banking & Reconciliation
- **Bank Connections**: Connect bank accounts for automatic transaction import
- **Smart Reconciliation**: AI-powered matching suggestions for faster reconciliation
- **Transaction Rules**: Automate categorization with customizable rules
- **Multi-Account Support**: Manage unlimited bank accounts across currencies

### Point of Sale (POS)
- **Enterprise POS**: Full-featured retail solution with barcode scanning and receipt printing
- **Offline Mode**: Continue selling without internet - transactions sync when connected
- **Hardware Integration**: Support for receipt printers, cash drawers, barcode scanners, and scales
- **Shift Management**: Complete shift tracking with opening/closing procedures
- **Loyalty Programs**: Points-based customer loyalty with tier levels
- **Restaurant Mode**: Table management, floor plans, kitchen display, and reservations

### Human Resources
- **Employee Management**: Complete employee profiles, documents, and onboarding
- **Payroll Processing**: Automated salary calculations, deductions, and statutory compliance
- **Leave Management**: Leave requests, approvals, and balance tracking
- **Timesheets**: Time tracking for projects and billing
- **Departments**: Organizational structure management

### Customer Relationship Management (CRM)
- **Sales Pipeline**: Visual deal tracking with customizable stages
- **Lead Management**: Capture, qualify, and convert leads
- **Activities**: Schedule calls, meetings, and follow-ups
- **Customer 360**: Complete view of customer interactions

### Project Management
- **Project Tracking**: Create and manage projects with milestones
- **Task Management**: Assign tasks, set deadlines, and track progress
- **Time Tracking**: Log time against projects for accurate billing
- **Project Invoicing**: Generate invoices from project time and expenses

### Studio & Customization
- **Custom Fields**: Add bespoke fields to any record type without code
- **Custom Forms & Views**: Tailor data entry layouts and saved views per team
- **Automations & Approvals**: Define rules that route work and trigger actions
- **Scheduled Reports**: Email reports to stakeholders on a recurring cadence

### Communication
- **SMS**: Centralised SMS templates, event rules, recipient groups, and opt-out tracking

### Financial Reporting
- **Standard Reports**: Profit & Loss, Balance Sheet, Cash Flow statements
- **Tax Reports**: VAT/GST reports, withholding tax, tax liability summaries
- **Management Reports**: Aging reports, sales analysis, expense breakdowns
- **Custom Reports**: Build custom reports with flexible filters and exports
- **Business Intelligence**: AI-powered insights and forecasting

## Architecture & Data Structure

AccrualFlow uses a hierarchical structure that mirrors how real businesses operate:

### Organization
The top-level entity that represents your company or group of companies. All data is isolated at the organization level, ensuring complete data separation for multi-tenant scenarios.

**Key attributes:**
- Organization name and branding
- Subscription and billing
- Platform-level settings
- User management

### Businesses
Under each organization, you can create multiple businesses. This is ideal for:
- Multiple legal entities under one holding company
- Different brands or product lines
- Separate profit centers

**Each business has:**
- Its own chart of accounts
- Independent invoicing sequences
- Separate tax settings
- Custom branding (logo, colors)
- Base currency

### Branches
Each business can have multiple branches representing physical locations:
- Retail stores
- Warehouses
- Regional offices
- Franchises

**Branch-specific features:**
- Local address and contact info
- Branch-specific pricing
- Local tax rates
- Separate inventory tracking
- Branch-level reporting

### Users & Roles
Team members are invited to organizations and assigned roles that determine their access levels. The permission system is granular, allowing you to control exactly what each role can view, create, edit, or delete.

## Data Integrity & Security

- **Row-Level Security**: Every database query is filtered by organization, ensuring users only see their data
- **Audit Logging**: All changes are logged with user, timestamp, and before/after values
- **Encryption**: Data encrypted at rest (AES-256) and in transit (TLS 1.3)
- **Backup & Recovery**: Automatic daily backups with point-in-time recovery capability
- **Compliance**: GDPR-compliant data handling with export and deletion capabilities
    `
  },
  {
    id: "quickstart",
    title: "Quick Start Guide",
    icon: Zap,
    content: `
# Quick Start Guide

Get your AccrualFlow account up and running in under 15 minutes with this comprehensive guide.

## Prerequisites

Before you begin, ensure you have:
- A valid email address for account verification
- Your business registration details (name, address, tax ID)
- Your logo in PNG or JPG format (recommended 400x400px)
- Bank account details (optional, for payment instructions)

## Step 1: Create Your Account

### Registration Process

1. **Visit the Signup Page**
   - Navigate to the AccrualFlow signup page
   - Enter your email address and create a strong password
   - Password must be at least 8 characters with mixed case and numbers

2. **Email Verification**
   - Check your inbox for the verification email
   - Click the verification link (valid for 24 hours)
   - If you don't see the email, check your spam folder

3. **Complete Profile**
   - Enter your full name
   - Set your timezone and language preference
   - Upload a profile photo (optional)

## Step 2: Onboarding Wizard

After verification, you'll be guided through the onboarding wizard:

### Business Information

1. **Organization Name**
   - This is your company or trading name
   - Will appear on invoices and documents

2. **Legal Details**
   - Legal/registered name (if different from trading name)
   - Registration number
   - Tax identification number (PIN, VAT number, etc.)

3. **Contact Information**
   - Business address (used on invoices)
   - Phone number
   - Email address for business communications

4. **Branding**
   - Upload your company logo
   - Set primary brand color (used in documents)

### Financial Settings

1. **Base Currency**
   - Select your primary operating currency
   - All reports default to this currency
   - You can add additional currencies later

2. **Fiscal Year**
   - Set your financial year start month
   - Common: January or April

3. **Tax Configuration**
   - Select your tax jurisdiction
   - Configure standard tax rates
   - Enable/disable tax-inclusive pricing

### Team Invitations

During setup, you can invite team members:
- Enter email addresses of team members
- Assign roles (Admin, Accountant, Sales, etc.)
- Team members receive invitation emails automatically
- They can accept and join your organization

## Step 3: Add Your First Customer

Customers (contacts) are central to invoicing. Let's add your first one:

1. **Navigate to Contacts**
   - Click "Contacts" in the sidebar

2. **Create New Contact**
   - Click "Add Contact" button
   - Select contact type: Customer, Vendor, or Both

3. **Enter Details**
   - **Name**: Individual or company name
   - **Email**: For sending invoices (optional but recommended)
   - **Phone**: Contact number
   - **Address**: Billing address for invoices
   - **Tax ID**: Their tax identification (for B2B)

4. **Save Contact**
   - Click "Save" to create the contact
   - The contact is now available for invoices

### Pro Tips for Contacts
- Use "Both" type for contacts who are both customers and vendors
- Add notes for payment preferences or special instructions
- Keep email addresses updated for invoice delivery

## Step 4: Configure Payment Methods

Before sending invoices, set up how customers can pay you:

1. **Navigate to Settings → Payment Methods**
   - Click "Add Payment Method"

2. **Add Bank Account**
   - Select "Bank" as type
   - Enter bank name, account name, account number
   - Add branch and SWIFT code if needed

3. **Add Mobile Money (M-Pesa)**
   - Select "Mobile Money" as type
   - Enter Paybill/Till number
   - Configure account reference format
   - Enable QR code generation for invoices

4. **Set Defaults**
   - Check "Show on documents by default" for primary methods
   - Arrange display order as needed

## Step 5: Create Your First Invoice

Now let's create and send your first invoice:

1. **Navigate to Invoices**
   - Click "Invoices" in the sidebar
   - Click "New Invoice"

2. **Select Customer**
   - Choose from your contacts list
   - Or create a new contact inline

3. **Set Dates**
   - **Invoice Date**: Defaults to today
   - **Due Date**: Based on payment terms
   - **Payment Terms**: Net 30, Net 15, Due on Receipt, etc.

4. **Add Line Items**
   For each item or service:
   - **Description**: What you're billing for
   - **Quantity**: Number of units
   - **Unit Price**: Price per unit
   - **Tax Rate**: Applicable tax (optional)
   
   The system calculates line totals automatically.

5. **Review Totals**
   - Subtotal (before tax)
   - Tax amount (calculated)
   - Total due
   - Amount in words (for legal clarity)

6. **Add Notes**
   - Payment instructions
   - Terms and conditions
   - Thank you message

7. **Save or Send**
   - **Save as Draft**: For review before sending
   - **Save & Send**: Email directly to customer

## Step 6: Record Your First Payment

When a customer pays:

1. **Open the Invoice**
   - Go to Invoices
   - Click on the invoice to open it

2. **Record Payment**
   - Click "Record Payment" button
   - Enter payment details:
     - **Amount**: Full or partial payment
     - **Date**: When payment was received
     - **Method**: Cash, Bank Transfer, M-Pesa, etc.
     - **Reference**: Transaction reference number

3. **Save Payment**
   - The invoice status updates automatically
   - Partial payments show balance remaining
   - Full payment marks invoice as "Paid"

## Step 7: Explore Apps Marketplace

AccrualFlow uses an apps-based architecture. Activate the features you need:

1. **Navigate to Apps**
   - Click "Apps" in the sidebar

2. **Browse Available Apps**
   - **Finance**: Accounting, banking, budgets, fixed assets
   - **Sales**: Invoices, estimates, recurring billing, credit notes
   - **Purchases**: Bills, RFQs, purchase orders, vendor returns
   - **Inventory**: Products, stock, warehouses, replenishment
   - **POS**: Point of sale, shifts, POS reports
   - **CRM**: Pipeline, activities, contacts
   - **HR**: Employees, Time Off, Attendance, Timesheets, Payroll
   - **Projects**: Tasks, milestones, workload
   - **Reports**: Financial statements, ledgers, tax, BI
   - **Studio**: Custom fields, forms, automations, approvals
   - **SMS**: Templates, event rules, recipient groups

3. **Activate Apps**
   - Click on an app to see details
   - Click "Activate" to enable
   - Some apps may require additional setup

## Step 8: Explore Key Features

Now that basics are set up, explore these features:

### Dashboard
- View financial overview at a glance
- Quick stats: receivables, payables, cash position
- Recent activity and upcoming tasks

### Reports
- Profit & Loss statement
- Outstanding receivables
- Tax summaries

### Settings
- Customize invoice templates
- Set up email notifications
- Configure payment methods

## Next Steps

With the basics complete, consider these advanced features:

1. **Connect Your Bank**
   - Automate transaction import
   - Speed up reconciliation

2. **Set Up Recurring Invoices**
   - Automate regular billing
   - Save time on repeat customers

3. **Invite Team Members**
   - Add accountants or staff
   - Assign appropriate roles

4. **Configure POS** (if applicable)
   - Set up retail registers
   - Enable offline selling

5. **Enable Tax Compliance**
   - Connect to eTIMS (Kenya)
   - Automate tax reporting

6. **Customize with Studio**
   - Add custom fields, forms, and views
   - Automate routine work with rules and approvals

## Getting Help

If you need assistance:
- **Help Center**: Browse our knowledge base
- **Documentation**: You're reading it!
- **AI Assistant**: Click the chat bubble for instant help
- **Support**: Contact our support team

Welcome to AccrualFlow! We're excited to have you on board.
    `
  },
  {
    id: "apps",
    title: "Apps Marketplace",
    icon: Grid3X3,
    content: `
# Apps Marketplace

AccrualFlow uses a modular, apps-based architecture that lets you customize your workspace with exactly the features you need. Activate only what you use for a cleaner, more focused experience.

## Understanding Apps

### What Are Apps?

Apps are feature modules that can be activated or deactivated based on your business needs. Each app provides specific functionality:

- **Core Apps**: Always available (Dashboard, Contacts, Settings)
- **Feature Apps**: Optional modules you can enable
- **Premium Apps**: Advanced features on higher plans

### Benefits of Apps Architecture

1. **Simplified Interface**: Only see features you actually use
2. **Faster Navigation**: Less clutter, quicker access
3. **Scalable**: Add capabilities as your business grows
4. **Organized**: Related features grouped logically

## Available Apps

### Finance Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Invoices** | Billing & invoicing | Create, send, track invoices |
| **Expenses** | Expense tracking | Receipt capture, categorization |
| **Accounts** | Chart of accounts | GL management, account types |
| **Banking** | Bank management | Accounts, reconciliation, feeds |
| **Budgets** | Budget planning | Create budgets, track actuals |
| **Fixed Assets** | Asset management | Depreciation, tracking |
| **Journal Entries** | Manual journals | Adjusting entries, corrections |

### Sales Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **CRM** | Customer relationship | Pipeline, leads, activities |
| **Estimates** | Quotes & proposals | Create estimates, convert to invoice |
| **Sales Orders** | Order management | Order processing, fulfillment |
| **Proforma Invoices** | Pre-invoices | Quotations, customs docs |
| **Recurring Invoices** | Subscription billing | Automated recurring charges |
| **Credit Notes** | Refunds & credits | Issue credits, link to invoices |
| **Customer Statements** | Statement generation | Periodic statements, aging |

### Purchases Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Bills** | Vendor invoices | Bill entry, payment scheduling |
| **Purchase Orders** | Procurement | Create POs, receive goods |
| **Purchase Returns** | Returns handling | Return goods to vendors |

### Inventory Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Products** | Product catalog | Items, pricing, images |
| **Inventory** | Stock management | Levels, movements, alerts |
| **Warehouses** | Multi-location | Warehouse setup, transfers |
| **Delivery Notes** | Shipping docs | Delivery tracking, signatures |
| **Sales Returns** | Customer returns | Return processing, restocking |

### Point of Sale Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **POS** | Retail terminal | Sales processing, receipts, shifts |
| **POS Reports** | Sales analytics | Z-reports, shift summaries, product mix |
| **Floor Plan** | Restaurant layout | Table management, sections (Restaurant mode) |
| **Kitchen Display** | Kitchen orders | Order display, completion (Restaurant mode) |
| **Reservations** | Table bookings | Booking management (Restaurant mode) |

### HR Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Employees** | Employee records | Profiles, departments, job positions, org chart |
| **Time Off** | Leave management | Requests, approvals, allocations, balances |
| **Attendance** | Time & attendance | Check-in/out, corrections, kiosk mode, schedules |
| **Timesheets** | Time tracking | Hours logging, project time, approvals |
| **Payroll** | Salary processing | Pay runs, loans, statutory rules, remittances |

### Project Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Projects** | Project management | Tasks, milestones, workload, documents |
| **Timesheets** | Time logging | Log time against projects |

### Reporting Apps

| App | Description | Key Features |
|-----|-------------|--------------|
| **Reports** | Standard reports | Financial statements, trial balance, ledgers, aging, tax |
| **Business Intelligence** | Advanced analytics | AI insights, dashboards |
| **Audit Logs** | Activity tracking | User actions, changes |

### Platform & Customization

| App | Description | Key Features |
|-----|-------------|--------------|
| **Studio** | No-code customization | Custom fields, forms, views, automations, approvals, scheduled reports |
| **SMS** | Outbound messaging | Templates, event rules, recipient groups, opt-outs, delivery log |
| **Platform Settings** | Workspace admin | Team, data migration, audit logs, compliance |

## Activating Apps

### How to Activate

1. **Navigate to Apps**
   - Click "Apps" in the main sidebar
   - Browse available apps by category

2. **View App Details**
   - Click on any app card
   - See description and features
   - Check requirements

3. **Activate**
   - Click "Activate" button
   - App appears in your sidebar
   - Start using immediately

### Activation Options

During activation, some apps offer configuration:

- **Initial Setup**: Configure basic settings
- **Data Import**: Import existing data
- **Team Access**: Set who can access the app
- **Notifications**: Configure alerts

### Deactivating Apps

To remove an app you no longer need:

1. Go to Apps
2. Find the active app
3. Click to open details
4. Click "Deactivate"
5. Confirm deactivation

**Note**: Deactivating doesn't delete data. Reactivate anytime to restore access.

## App Dependencies

Some apps require other apps to function:

| App | Requires |
|-----|----------|
| Recurring Invoices | Invoices |
| Purchase Orders | Products |
| Payroll | Employees |
| Kitchen Display | POS |
| Floor Plan | POS |

The system automatically activates required apps.

## App Permissions

### Role-Based Access

Each app respects your role-based permissions:

- **View**: See data in the app
- **Create**: Add new records
- **Edit**: Modify existing records
- **Delete**: Remove records
- **Full Access**: All permissions

### App-Specific Roles

Some apps have specialized roles:
- **POS Cashier**: POS terminal access only
- **Payroll Admin**: Payroll processing
- **HR Manager**: Employee management

Configure in Settings → Team → Roles.

## Best Practices

### Start Small
- Activate core apps first (Invoices, Expenses, Contacts)
- Add more as you need them
- Don't activate everything at once

### Organize Your Workflow
- Group related apps in your sidebar
- Use the Home dashboard for quick access
- Create shortcuts for frequent actions

### Train Your Team
- Activate apps based on team needs
- Different roles may need different apps
- Provide training on new apps

### Regular Review
- Review active apps quarterly
- Deactivate unused apps
- Check for new apps that could help
    `
  },
  {
    id: "invoicing",
    title: "Invoicing Guide",
    icon: FileText,
    content: `
# Invoicing Guide

Master professional invoicing with AccrualFlow's comprehensive invoicing system. This guide covers everything from basic invoices to advanced features like recurring billing and credit notes.

## Understanding Invoice Types

AccrualFlow supports multiple document types for different business scenarios:

| Document Type | Purpose | Converts To |
|--------------|---------|-------------|
| Estimate | Quote/proposal before work | Invoice |
| Proforma Invoice | Formal quote, often for customs | Invoice |
| Invoice | Billing document for payment | Credit Note |
| Recurring Invoice | Automated periodic billing | Invoice |
| Credit Note | Refund or adjustment | - |

## Creating Invoices

### Standard Invoice Creation

1. **Access Invoice Form**
   - Navigate to Invoices > New Invoice
   - Or use keyboard shortcut Ctrl/Cmd + I

2. **Header Information**
   - **Customer**: Select existing or create new
   - **Invoice Number**: Auto-generated (customizable prefix)
   - **Invoice Date**: Defaults to today
   - **Due Date**: Calculated from payment terms
   - **Currency**: Defaults to customer's currency or base currency
   - **Reference**: Your reference number (optional)

3. **Line Items**
   Each line item includes:
   - **Product/Service**: Select from catalog or enter manually
   - **Description**: Detailed description of the item
   - **Quantity**: Number of units (supports decimals)
   - **Unit**: Unit of measure (pcs, hrs, kg, etc.)
   - **Unit Price**: Price per unit before tax
   - **Discount**: Per-line discount (amount or percentage)
   - **Tax Rate**: Applicable tax rate
   - **Line Total**: Auto-calculated

4. **Calculations**
   The invoice automatically calculates:
   - Subtotal (sum of line items)
   - Discount (if any)
   - Tax breakdown by rate
   - Total amount due
   - Amount in words

5. **Additional Information**
   - **Notes**: Payment instructions, thank you message
   - **Terms**: Terms and conditions
   - **Attachments**: Supporting documents
   - **Internal Notes**: Notes visible only to your team

### Invoice Numbering System

AccrualFlow uses an intelligent numbering system:

**Format**: [PREFIX]-[YEAR][SEQUENCE]

Examples:
- INV-2024-0001
- BILL-2024-0001
- EST-2024-0001

**Customization Options:**
- Change prefix per document type
- Include/exclude year
- Set starting sequence number
- Per-business numbering (multi-business setup)

Configure in Settings > Business Settings > Document Numbers

### Multi-Currency Invoicing

Invoice customers in their preferred currency:

1. **Currency Selection**
   - Choose currency when creating invoice
   - Exchange rate auto-populated from current rates

2. **Exchange Rate**
   - View and edit the applied rate
   - Lock rate at time of creation
   - Rate source: Central bank or commercial rates

3. **Reporting**
   - Invoice recorded in customer's currency
   - Converted to base currency for reporting
   - Exchange gains/losses tracked automatically

## Payment Methods on Invoices

### Configuring Payment Methods

Navigate to Settings → Payment Methods to set up how customers can pay:

1. **Bank Accounts**
   - Add multiple bank accounts
   - Enter bank name, account number, branch
   - Include SWIFT/IBAN for international payments

2. **Mobile Money (M-Pesa)**
   - Add Paybill or Till number
   - Configure account reference format
   - Enable QR code for easy scanning

3. **Online Payments**
   - PayPal email address
   - Payment links
   - Other online wallets

4. **Cash/Other**
   - Configure instructions for cash payments
   - Custom payment methods

### Selecting Methods per Invoice

In your document templates, select which payment methods appear:

1. Go to Settings → Templates
2. Select document type (Invoice, Proforma, etc.)
3. In Footer Section, check "Show Payment Methods"
4. Select which configured methods to display
5. Save template

Different document types can show different payment methods.

## Recurring Invoices

Automate billing for subscription or retainer clients:

### Setting Up Recurring Invoices

1. **Create Template**
   - Go to Recurring Invoices > Create New
   - Set up like a regular invoice

2. **Schedule Configuration**
   - **Frequency**: Weekly, Monthly, Quarterly, Yearly
   - **Start Date**: When to begin
   - **End Date**: Optional end date
   - **Day of Month**: Which day to generate (for monthly)

3. **Automation Options**
   - **Auto-generate**: Create invoices automatically
   - **Auto-send**: Email invoices upon creation
   - **Auto-remind**: Send payment reminders

4. **Variable Fields**
   - Use placeholders for dynamic content
   - {PERIOD_START}, {PERIOD_END} for date ranges
   - {SEQUENCE} for incrementing numbers

### Managing Recurring Invoices

- View upcoming scheduled invoices
- Pause/resume schedules
- Modify templates (affects future invoices only)
- View history of generated invoices

## Estimates & Quotes

Win business with professional estimates:

### Creating Estimates

1. **Standard Creation**
   - Navigate to Estimates > New Estimate
   - Fill in similar to invoice

2. **Estimate-Specific Fields**
   - **Expiry Date**: How long quote is valid
   - **Terms**: Quote-specific terms
   - **Validity Notes**: Any conditions

3. **Sending Estimates**
   - Email with professional template
   - Include cover letter
   - Request approval

### Estimate Workflow

**Status Flow:**
Draft → Sent → Viewed → Accepted/Declined → Invoiced

1. **Draft**: Estimate being prepared
2. **Sent**: Emailed to customer
3. **Viewed**: Customer opened the email/link
4. **Accepted**: Customer approved (if approval enabled)
5. **Declined**: Customer rejected
6. **Invoiced**: Converted to invoice

### Converting to Invoice

When estimate is accepted:

1. Open the estimate
2. Click "Convert to Invoice"
3. Review details (make adjustments if needed)
4. Create invoice

The estimate links to the invoice for tracking.

## Payment Recording

### Recording Full Payment

1. Open the invoice
2. Click "Record Payment"
3. Enter:
   - Amount (defaults to balance due)
   - Payment date
   - Payment method
   - Reference/transaction number
   - Bank account (for reconciliation)
4. Save payment

### Partial Payments

AccrualFlow handles partial payments automatically:

- Record any amount less than total
- Balance due updates
- Invoice shows "Partially Paid" status
- Multiple payments tracked individually

### Overpayments

When a customer pays more than owed:

1. Record the full payment amount
2. System creates a credit balance
3. Apply credit to future invoices
4. Or issue refund

## Credit Notes

Issue credit notes for returns, errors, or adjustments:

### Creating Credit Notes

1. **From Invoice**: 
   - Open original invoice
   - Click "Create Credit Note"
   - Pre-populated with invoice details

2. **Standalone**:
   - Go to Credit Notes > New
   - Select customer
   - Add line items

### Credit Note Details

- Reference original invoice
- Specify reason for credit
- Line items (positive amounts representing credit)
- Tax adjustment handled automatically

### Applying Credits

Credit notes can be:
1. Applied to unpaid invoices
2. Applied to future invoices
3. Refunded to customer

## Invoice Templates

### Customizing Templates

Navigate to Settings → Templates to customize:

1. **Select Document Type**
   - Invoice, Proforma, Estimate, Credit Note, etc.

2. **Header Section**
   - Logo placement and size
   - Company information display
   - Customer information layout

3. **Items Section**
   - Column visibility (SKU, tax, discount)
   - Column order
   - Line item formatting

4. **Footer Section**
   - Payment methods (select from configured methods)
   - Bank details display
   - Terms and conditions
   - Notes section

5. **Styling**
   - Colors and fonts
   - Table styling
   - Page margins

### Multiple Templates

Create different templates for different purposes:
- Standard invoice
- Simplified receipt
- Detailed professional invoice
- Retail receipt format

## Tax Compliance Integration

For eTIMS (Kenya):
- Automatic transmission on send
- CU (Control Unit) number assignment
- QR code generation
- Digital signature
- Audit trail

Status indicators show transmission status.
    `
  },
  {
    id: "payment-methods",
    title: "Payment Methods",
    icon: Wallet,
    content: `
# Payment Methods

Configure multiple payment methods that appear on your invoices and documents. AccrualFlow supports a centralized payment method registry, allowing you to manage all payment options in one place and select which ones appear on each document type.

## Overview

### Centralized Management

Instead of manually typing bank details on each template, AccrualFlow uses a centralized registry:

1. **Configure Once**: Set up payment methods in Settings
2. **Use Everywhere**: Select methods for each document type
3. **Update Easily**: Change details in one place, updates everywhere
4. **Multiple Options**: Offer customers various payment channels

### Supported Payment Types

| Type | Description | Examples |
|------|-------------|----------|
| **Bank** | Bank account transfers | KCB, Equity, Standard Chartered |
| **Mobile Money** | Mobile payment services | M-Pesa, Airtel Money |
| **Online** | Digital payment platforms | PayPal, Stripe |
| **Cash** | Physical cash payments | Cash on delivery |
| **Crypto** | Cryptocurrency payments | Bitcoin, USDT |

## Setting Up Payment Methods

### Accessing Payment Methods

1. Navigate to **Settings**
2. Click on **Payment Methods** tab
3. View existing methods or add new ones

### Adding a Bank Account

1. Click **"Add Payment Method"**
2. Select **"Bank"** as type
3. Enter details:
   - **Label**: Display name (e.g., "KCB Corporate Account")
   - **Bank Name**: Financial institution name
   - **Account Name**: Name on the account
   - **Account Number**: Full account number
   - **Branch**: Branch name or code
   - **SWIFT Code**: For international transfers (optional)
   - **IBAN**: International bank account number (optional)
4. Configure options:
   - **Show by default**: Appear on new documents automatically
   - **Generate QR code**: Include QR for easy scanning
5. Click **Save**

### Adding Mobile Money (M-Pesa)

1. Click **"Add Payment Method"**
2. Select **"Mobile Money"** as type
3. Enter details:
   - **Label**: Display name (e.g., "Pay via M-Pesa")
   - **Provider**: M-Pesa, Airtel Money, etc.
   - **Paybill/Till Number**: Business number
   - **Account Number**: Default account reference
   - **Phone Number**: Business phone (optional)
4. Configure options:
   - **Show by default**: Appear on new documents
   - **Generate QR code**: Creates scannable M-Pesa QR
5. Click **Save**

### Adding Online Payments

1. Click **"Add Payment Method"**
2. Select **"Online"** as type
3. Enter details:
   - **Label**: Display name (e.g., "PayPal")
   - **Provider**: PayPal, Stripe, etc.
   - **Email**: Payment account email
   - **Payment Link**: Direct payment URL (optional)
4. Click **Save**

### Adding Cash Payment Option

1. Click **"Add Payment Method"**
2. Select **"Cash"** as type
3. Enter details:
   - **Label**: Display name (e.g., "Cash on Delivery")
   - **Instructions**: Payment instructions for customers
4. Click **Save**

## Managing Payment Methods

### Editing Methods

1. Find the payment method in the list
2. Click the **Edit** button
3. Modify details as needed
4. Click **Save**

### Deleting Methods

1. Find the payment method in the list
2. Click the **Delete** button
3. Confirm deletion

**Note**: Deleting a payment method removes it from future documents but doesn't affect already-created documents.

### Setting Default Methods

Toggle "Show by default" for methods that should appear on all new documents automatically. You can still override this per document template.

### Display Order

Drag and drop payment methods to set the order they appear on documents. Most commonly used methods should be at the top.

## Using in Document Templates

### Selecting Methods per Template

1. Go to **Settings → Templates**
2. Select document type (Invoice, Proforma, etc.)
3. Scroll to **Footer Section**
4. Check **"Show Payment Methods"**
5. Select which payment methods to display:
   - ✓ KCB Corporate Account
   - ✓ M-Pesa Paybill 123456
   - ☐ PayPal Business
6. Click **Save Template**

### Different Methods for Different Documents

You can configure different payment methods for different document types:

- **Invoices**: Bank + M-Pesa
- **Proforma Invoices**: Bank only
- **POS Receipts**: M-Pesa + Cash
- **International Invoices**: Bank with SWIFT

## QR Codes

### M-Pesa QR Codes

When enabled, AccrualFlow generates M-Pesa QR codes that customers can scan:

1. Enable "Generate QR code" on the payment method
2. QR code appears on invoice PDF
3. Customer scans with M-Pesa app
4. Payment details pre-filled

### Bank QR Codes

For banks that support QR payments:

1. Enable QR code generation
2. QR encodes account details
3. Customer scans with banking app
4. Account details auto-populated

## Integration with Banking

### Linking to Bank Accounts

Payment methods can be linked to your banking module:

1. When adding a bank payment method
2. Select "Link to existing bank account"
3. Choose from your configured bank accounts
4. Details sync automatically

### Benefits of Linking

- Account details stay in sync
- Easier reconciliation
- Consistent account references
- Automatic updates if bank details change

## Best Practices

### Organization

- Use clear, descriptive labels
- Include currency in label for multi-currency (e.g., "KCB USD Account")
- Group similar methods together

### Customer Experience

- Offer multiple payment options
- Include the most convenient methods for your customers
- Consider regional preferences (M-Pesa in Kenya, etc.)

### Accuracy

- Double-check account numbers before saving
- Verify Paybill/Till numbers are correct
- Test QR codes to ensure they work

### Security

- Don't share payment method setup screens
- Verify changes with account statements
- Audit payment methods periodically
    `
  },
  {
    id: "expenses",
    title: "Expense Management",
    icon: CreditCard,
    content: `
# Expense Management

Comprehensive expense tracking to maintain visibility over every outgoing transaction. From petty cash to major vendor payments, AccrualFlow ensures nothing slips through the cracks.

## Expense Types Overview

AccrualFlow distinguishes between different types of outgoing transactions:

| Type | Purpose | Payment |
|------|---------|---------|
| Expense | Direct costs already paid | Immediate |
| Bill | Vendor invoice to be paid | Future |
| Purchase Order | Formal order to vendor | After receipt |

## Recording Expenses

### Quick Expense Entry

For immediate, paid expenses:

1. **Navigate to Expenses**
   - Click Expenses in sidebar
   - Click "Add Expense"

2. **Basic Information**
   - **Description**: What was purchased
   - **Amount**: Total cost
   - **Date**: When expense occurred
   - **Payment Method**: How it was paid
   - **Bank Account**: Which account was used

3. **Categorization**
   - **Category**: Expense category for reporting
   - **Vendor**: Who was paid (optional)
   - **Project**: Associated project (if applicable)
   - **Tags**: Custom tags for filtering

4. **Documentation**
   - Upload receipt image
   - Attach supporting documents
   - Add notes or memo

5. **Tax Treatment**
   - Input VAT/GST for claiming
   - Tax-exempt indication
   - Withholding tax (if applicable)

### Expense Categories

Standard categories included:

**Operating Expenses:**
- Advertising & Marketing
- Bank Charges & Fees
- Communication (Phone, Internet)
- Insurance
- Legal & Professional Fees
- Office Supplies
- Rent & Lease
- Repairs & Maintenance
- Travel & Entertainment
- Utilities

**Cost of Goods Sold:**
- Direct Labor
- Direct Materials
- Freight & Shipping
- Subcontractors

**Custom Categories:**
Create categories that match your chart of accounts in Settings > Categories.

### Receipt Management

**Uploading Receipts:**
- Drag and drop images
- Take photo with mobile device
- Attach PDF documents
- Maximum size: 10MB per file
- Supported formats: JPEG, PNG, PDF

**Receipt Features:**
- Thumbnail preview
- Full-size viewing
- Download original
- Multiple receipts per expense
- Receipt required flag (for compliance)

## Bills (Accounts Payable)

For vendor invoices that will be paid later:

### Creating Bills

1. **Access Bill Form**
   - Navigate to Bills > New Bill
   - Or create from Purchase Order

2. **Vendor Selection**
   - Choose existing vendor
   - Or create new vendor inline
   - Vendor defaults applied (terms, account)

3. **Bill Details**
   - **Bill Number**: Vendor's invoice number
   - **Bill Date**: Date on vendor invoice
   - **Due Date**: When payment is expected
   - **Currency**: If foreign vendor

4. **Line Items**
   - Product/Service
   - Description
   - Quantity and Unit
   - Unit Price
   - Tax Rate
   - Line Total

5. **Attachments**
   - Upload vendor invoice
   - Supporting documents
   - Correspondence

### Bill Workflow

**Status Flow:**
Draft → Awaiting Approval → Approved → Awaiting Payment → Paid

### Recording Bill Payments

1. **Open the Bill**
2. **Click "Make Payment"**
3. **Enter Payment Details:**
   - Amount (full or partial)
   - Payment date
   - Payment method
   - Reference number
   - Bank account

## Purchase Orders

Formalize procurement before committing to payment:

### Purchase Order Creation

1. **Header Information**
   - Vendor selection
   - Ship-to address
   - Expected delivery date
   - Currency and terms

2. **Line Items**
   - Products from catalog
   - Custom items
   - Quantities and prices
   - Specifications

### Purchase Order Workflow

Draft → Sent → Acknowledged → Receiving → Closed

### Receiving Goods

1. **Open Purchase Order**
2. **Click "Receive Goods"**
3. **Enter Received Quantities**
   - Full or partial receipt
   - Note any discrepancies
4. **Create Delivery Record**
   - Links to PO
   - Updates inventory

### Converting to Bill

When vendor invoice arrives:

1. Open the Purchase Order
2. Click "Convert to Bill"
3. Review against received goods
4. Adjust for any variances
5. Create and save bill

## Vendor Management

### Vendor Profiles

Each vendor record includes:
- Contact information
- Payment terms
- Default expense account
- Currency preference
- Tax details
- Transaction history

### Vendor Credits

When vendors issue credits:

1. **Record Credit**
   - Create vendor credit note
   - Reference original bill
   - Enter credit amount

2. **Apply Credit**
   - Apply to outstanding bills
   - Carry forward for future
   - Request refund

## Reporting & Analysis

### Expense Reports

- **By Category**: See spending breakdown
- **By Vendor**: Top vendors by spend
- **By Period**: Month-over-month trends
- **By Project**: Project cost tracking

### Budget vs. Actual

- Set expense budgets by category
- Track actual spending
- Variance analysis
- Alerts for overspending
    `
  },
  {
    id: "banking",
    title: "Banking & Reconciliation",
    icon: Building2,
    content: `
# Banking & Reconciliation

Keep your books perfectly synchronized with your bank accounts through AccrualFlow's powerful banking features.

## Bank Account Management

### Adding Bank Accounts

1. **Navigate to Banking**
   - Click Banking in sidebar
   - Select "Bank Accounts"
   - Click "Add Bank Account"

2. **Account Information**
   - **Account Name**: Descriptive name
   - **Bank Name**: Financial institution
   - **Account Number**: Last 4 digits for reference
   - **Account Type**: Checking, Savings, Credit Card
   - **Currency**: Account currency
   - **Opening Balance**: Starting balance (with date)

3. **Connection Type**
   - **Manual**: Upload transactions via CSV
   - **Connected**: Automatic sync via bank integration

### Bank Account Structure

For proper accounting:
- Each bank account links to a General Ledger account
- Default accounts created: 
  - Bank Account (Asset)
  - Interest Income
  - Bank Charges (Expense)

## Connecting Banks

### Supported Integrations

AccrualFlow supports bank connections through:
- Open Banking (where available)
- Plaid (international)
- Direct bank integrations
- CSV import (universal)

### Connection Process

1. **Initiate Connection**
   - Click "Connect Bank"
   - Search for your bank
   - Select from results

2. **Authenticate**
   - Redirect to bank's secure login
   - Enter your credentials (we never see them)
   - Authorize data access

3. **Select Accounts**
   - View available accounts
   - Select accounts to connect
   - Set sync preferences

4. **Confirm Connection**
   - Review connection details
   - Accept terms
   - Start initial sync

### Connection Security

- OAuth 2.0 authentication
- Read-only access (we cannot move money)
- Bank-level encryption
- Revoke access anytime
- No credential storage

## Bank Reconciliation

### Understanding Reconciliation

Reconciliation ensures your AccrualFlow records match your bank statement:

**Book Balance** = Your recorded balance
**Bank Balance** = Statement balance
**Difference** = Unreconciled items

### Reconciliation Process

1. **Start Reconciliation**
   - Go to Bank Reconciliation
   - Select bank account
   - Enter statement ending date
   - Enter statement ending balance

2. **Match Transactions**
   For each bank transaction:
   
   - **Match to Existing**
     - Link to invoice payment
     - Link to expense
     - Link to bill payment
     
   - **Create New**
     - Create expense
     - Create income
     - Create transfer
     
   - **Exclude**
     - Personal transactions
     - Already matched elsewhere

3. **Review & Complete**
   - Verify zero difference
   - Note unmatched items
   - Finalize reconciliation

### Smart Matching

AccrualFlow suggests matches based on:
- Amount matching
- Date proximity
- Description patterns
- Historical patterns

### Bank Feeds

For connected banks:
- Automatic transaction import
- Daily sync (or more frequent)
- Categorization suggestions
- Rule-based auto-categorization

## Transaction Rules

### Creating Rules

Automate categorization:

1. **Define Match Criteria**
   - Description contains
   - Amount range
   - Transaction type

2. **Set Actions**
   - Assign category
   - Assign vendor/customer
   - Add to specific account

3. **Apply Automatically**
   - New transactions matching rules
   - Auto-categorized on import

### Rule Examples

- "STARBUCKS" → Meals & Entertainment
- "SAFARICOM" → Communication
- "KRA" → Tax Payments
- Amount > 50,000 → Flag for review
    `
  },
  {
    id: "pos",
    title: "Point of Sale (POS)",
    icon: ShoppingCart,
    content: `
# Point of Sale (POS)

AccrualFlow POS provides a complete retail and restaurant solution with offline capability, hardware integration, and seamless accounting integration.

## POS Overview

### Key Features

- Full-featured sales terminal
- Offline mode with automatic sync
- Hardware integration (printers, scanners, scales)
- Shift management
- Customer loyalty programs
- Restaurant table management
- Kitchen display system
- Multiple registers per location

### POS Architecture

**Registers**: Individual selling stations
**Shifts**: Cashier sessions with opening/closing
**Sessions**: Table/order sessions (restaurant mode)

## Getting Started

### Initial Setup

1. **Enable POS App**
   - Go to Apps
   - Activate "POS" app
   - Complete initial configuration

2. **Create Register**
   - Navigate to POS > Settings
   - Click "Add Register"
   - Configure:
     - Register name
     - Location/branch
     - Default payment methods
     - Receipt settings

3. **Configure Products**
   - Ensure products are created
   - Set POS-specific settings:
     - Available in POS
     - Quick access buttons
     - Category organization

### Register Types

| Type | Best For |
|------|----------|
| Retail | Standard retail sales |
| Restaurant | Table service, kitchen orders |
| Quick Service | Fast food, takeaway |
| Bar | Drinks, tabs, quick service |

## User Permissions

### POS Roles

#### Cashier
- Process sales
- Apply preset discounts
- Handle basic returns
- View own shift

#### Supervisor
- All cashier functions
- Override discounts
- Process all returns
- Access all shifts
- Cash drawer access

#### Manager
- All supervisor functions
- Configure registers
- View reports
- Modify settings

### Override Operations

Operations requiring manager PIN:
- Discounts exceeding cashier limit
- Voids exceeding limits
- Returns above threshold
- Price changes
- Cash drawer opening

## Hardware Setup

### Receipt Printers

**Supported Printers:**
- ESC/POS compatible thermal printers
- USB connection (native or via Electron)
- Network printers (TCP/IP)
- Common brands: Epson, Star, Bixolon

**Configuration:**
1. Go to POS > Settings > Hardware
2. Click "Add Printer"
3. Select connection type
4. Configure:
   - Paper width (58mm, 80mm)
   - Auto-cut enabled
   - Print logo on receipts
   - Number of copies

### Barcode Scanners

**Supported Scanners:**
- USB HID (keyboard mode)
- Bluetooth scanners
- Camera-based (mobile)

**Setup:**
- Plug and play for USB HID
- Scanner automatically inputs product codes
- Configure prefix/suffix if needed

### Cash Drawers

**Connection Options:**
- Via receipt printer (RJ-11 connection)
- USB direct connection

**Configuration:**
- Drawer pulse duration
- Open on sale completion
- Open with manager override only

## Daily Operations

### Opening a Shift

1. **Access POS Terminal**
   - Navigate to POS Terminal
   - Select register

2. **Open Shift**
   - Click "Open Shift"
   - Enter opening float amount
   - Count and verify cash
   - Confirm opening

3. **Ready for Sales**
   - Terminal activates
   - Shift timer begins
   - Transactions can be processed

### Processing Sales

1. **Add Products**
   - Scan barcode
   - Search by name/SKU
   - Browse categories
   - Use quick buttons

2. **Adjust Items**
   - Modify quantity
   - Apply item discount
   - Remove items
   - Add notes

3. **Cart Actions**
   - Apply cart-wide discount
   - Add customer (for loyalty)
   - Hold transaction
   - Clear cart

4. **Payment**
   - Click "Pay" or press Enter
   - Select payment method
   - Enter received amount
   - Process payment
   - Print/email receipt

### Payment Methods

**Standard Methods:**
- Cash (with change calculation)
- Card (for external terminal)
- M-Pesa (STK push integration)
- Bank Transfer
- Credit (for account customers)

**Split Payments:**
- Multiple payment types per transaction
- Partial payments
- Balance tracking

### Closing a Shift

1. **Initiate Close**
   - Click "Close Shift"
   - System calculates expected cash

2. **Count Drawer**
   - Enter denomination counts
   - System calculates total
   - Variance displayed

3. **Review Shift**
   - Total sales by method
   - Number of transactions
   - Discounts given
   - Returns processed
   - Cash variance

4. **Complete Close**
   - Acknowledge variance (if any)
   - Sign off on totals
   - Print shift report
   - Shift ends

## Restaurant Features

### Floor Plan Management

1. **Access Floor Plan**
   - Navigate to POS > Floor Plan
   - View table layout

2. **Table Layout**
   - Drag and drop tables
   - Create different areas/sections
   - Set table capacity
   - Visual status indicators

3. **Table Status Colors**
   - Available (green)
   - Occupied (blue)
   - Awaiting payment (orange)
   - Reserved (gray)

### Table Sessions

1. **Open Table**
   - Click on available table
   - Assign server (optional)
   - Add guest count

2. **Take Orders**
   - Add items to order
   - Send to kitchen
   - Add courses
   - Modify items

3. **Manage Session**
   - Transfer table
   - Split bill
   - Merge tables
   - Add guests

4. **Close Table**
   - Generate bill
   - Process payment
   - Print receipt
   - Clear table

### Kitchen Display System (KDS)

**Setup:**
1. Enable Kitchen Display in POS settings
2. Configure kitchen stations
3. Assign product categories to stations

**Kitchen Flow:**
1. Order received on display
2. Kitchen acknowledges
3. Marks items ready
4. Server notified
5. Order completed

### Table Bookings

**Creating Reservations:**
1. Go to POS > Bookings
2. Click "New Booking"
3. Enter details:
   - Customer name/phone
   - Date and time
   - Party size
   - Table preference
   - Special requests

**Managing Bookings:**
- View calendar of bookings
- Confirm/cancel reservations
- Walk-in vs. reserved tables
- Waitlist management

## Offline Mode

### How It Works

1. **Connection Lost**
   - Visual indicator shows offline status
   - Operations continue normally
   - Data stored locally (IndexedDB)

2. **While Offline**
   - Process sales
   - Apply discounts
   - Accept payments
   - Print receipts (if local printer)

3. **Reconnection**
   - Automatic sync begins
   - Transactions upload
   - Inventory updates
   - No manual intervention needed

### Offline Limitations

- Cannot validate credit card payments
- Cannot verify M-Pesa via STK push
- Cannot check real-time inventory (uses cached)
- Cannot transmit to eTIMS (queued)

## Customer Loyalty

### Program Configuration

1. **Create Program**
   - Go to POS > Settings > Loyalty
   - Define program name
   - Set earning rules

2. **Earning Rules**
   - Points per currency unit (e.g., 1 point per KES 100)
   - Bonus categories
   - Multiplier events
   - Welcome bonus

3. **Tier Structure**
   - Bronze: 0-500 points
   - Silver: 501-2000 points
   - Gold: 2001+ points
   - Custom tiers

4. **Redemption**
   - Points value (e.g., 100 points = KES 10)
   - Minimum redemption
   - Expiration policy

### At Checkout

1. Identify customer
2. View points balance
3. Apply points as payment (partial or full)
4. Show new balance on receipt

## Reports

### Shift Reports

- Sales summary by payment method
- Transaction count
- Average transaction value
- Discounts given
- Returns processed
- Cash variance

### Sales Reports

- Sales by hour/day/week
- Sales by product category
- Sales by cashier
- Top selling items
- Slow moving items

## eTIMS Integration

For Kenya Revenue Authority compliance:

### Automatic Transmission

- Each sale transmitted in real-time
- CU (Control Unit) number assigned
- QR code generated
- Digital signature applied

### Receipt Requirements

- eTIMS receipt format
- Control unit number visible
- QR code for verification
- PIN of seller
- PIN of buyer (B2B)

### Offline Handling

- Transactions queued when offline
- Automatic retry on reconnection
- Supervisor notification for failures
- Manual retry option
    `
  },
  {
    id: "hr",
    title: "Human Resources",
    icon: Briefcase,
    content: `
# Human Resources

AccrualFlow HR provides complete employee management, payroll processing, leave management, and time tracking capabilities.

## Employee Management

### Adding Employees

1. **Navigate to Employees**
   - Click "Employees" in sidebar
   - Click "Add Employee"

2. **Personal Information**
   - Full name
   - Employee ID (auto-generated or custom)
   - Email address
   - Phone number
   - Date of birth
   - National ID / Passport number

3. **Employment Details**
   - Job title
   - Department
   - Reporting manager
   - Employment type (Full-time, Part-time, Contract)
   - Start date
   - Work location/branch

4. **Compensation**
   - Base salary
   - Pay frequency (Monthly, Bi-weekly, Weekly)
   - Currency
   - Bank account details
   - Allowances and deductions

5. **Documents**
   - Upload ID copies
   - Contracts
   - Certificates
   - Other documents

### Employee Profiles

Each employee profile includes:

**Personal Tab:**
- Contact information
- Emergency contacts
- Personal documents

**Employment Tab:**
- Position history
- Salary history
- Performance records

**Payroll Tab:**
- Salary breakdown
- Deductions
- Tax information
- Bank details

**Leave Tab:**
- Leave balances
- Leave history
- Pending requests

**Time Tab:**
- Timesheet entries
- Project time allocation

## Departments

### Creating Departments

1. **Navigate to Departments**
   - Click "Departments" in sidebar
   - Click "Add Department"

2. **Department Details**
   - Name
   - Code
   - Parent department (for hierarchy)
   - Department head
   - Cost center

### Organizational Structure

- View organization chart
- See reporting relationships
- Department hierarchy
- Headcount by department

## Payroll Processing

### Payroll Configuration

1. **Salary Components**
   - Basic salary
   - Housing allowance
   - Transport allowance
   - Medical allowance
   - Other allowances

2. **Deductions**
   - PAYE (Income Tax)
   - NSSF (Pension)
   - NHIF (Health Insurance)
   - HELB (Student Loans)
   - Custom deductions

3. **Pay Periods**
   - Monthly
   - Bi-weekly
   - Weekly

### Running Payroll

1. **Navigate to Payroll**
   - Click "Payroll" in sidebar
   - Click "Run Payroll"

2. **Select Pay Period**
   - Choose month/period
   - Select employees to include

3. **Review Calculations**
   - Gross pay
   - Deductions breakdown
   - Net pay
   - Verify each employee

4. **Approve Payroll**
   - Submit for approval
   - Manager/Finance approval
   - Final confirmation

5. **Process Payment**
   - Generate bank file
   - Or process individually
   - Mark as paid

6. **Generate Payslips**
   - Create individual payslips
   - Email to employees
   - Or print for distribution

### Payslip Details

Each payslip shows:
- Employee details
- Pay period
- Earnings (base + allowances)
- Deductions breakdown
- Net pay
- Year-to-date totals

## Leave Management

### Leave Types

Standard leave types:
- Annual Leave
- Sick Leave
- Maternity Leave
- Paternity Leave
- Compassionate Leave
- Unpaid Leave
- Study Leave

### Leave Policies

Configure for each leave type:
- Days entitled per year
- Accrual method (monthly/annually/upfront)
- Carry-over rules
- Maximum accumulation
- Required documentation

### Requesting Leave

**For Employees:**
1. Go to Leave > Request Leave
2. Select leave type
3. Choose dates
4. Add reason/notes
5. Attach documents (if required)
6. Submit request

**For Managers:**
1. Review pending requests
2. Check team calendar
3. Approve or reject
4. Add comments
5. Employee notified

### Leave Calendar

- View team leave calendar
- See who's out when
- Identify conflicts
- Plan coverage

### Leave Balances

Track for each employee:
- Opening balance
- Accrued this year
- Taken this year
- Pending requests
- Available balance

## Timesheets

### Time Entry

**For Employees:**
1. Navigate to Timesheets
2. Select week/period
3. Enter time by day:
   - Project/task
   - Hours worked
   - Description
4. Submit for approval

**Entry Methods:**
- Manual entry
- Timer (start/stop)
- Weekly grid view
- Quick copy from previous week

### Timesheet Approval

**For Managers:**
1. Review submitted timesheets
2. Verify hours and projects
3. Approve or return for correction
4. Approved time flows to payroll/billing

### Project Time

Track time against:
- Projects
- Tasks
- Clients
- Activities

Used for:
- Client billing
- Project costing
- Productivity analysis

## Reports

### HR Reports

- Employee roster
- Headcount by department
- Tenure analysis
- Turnover rates

### Payroll Reports

- Payroll summary
- Deductions report
- Bank file
- Tax reports (P9, P10)
- Statutory remittances

### Leave Reports

- Leave balance report
- Leave taken summary
- Leave liability
- Absence patterns

### Timesheet Reports

- Hours by employee
- Hours by project
- Billable vs. non-billable
- Utilization rates
    `
  },
  {
    id: "crm",
    title: "CRM & Sales Pipeline",
    icon: Target,
    content: `
# CRM & Sales Pipeline

AccrualFlow CRM helps you manage your sales process from lead capture to deal closure, with visual pipeline management and activity tracking.

## Overview

### CRM Features

- **Lead Management**: Capture and qualify leads
- **Pipeline View**: Visual deal tracking
- **Activities**: Schedule and track touchpoints
- **Customer 360**: Complete customer history
- **Sales Forecasting**: Revenue projections

## Pipeline Management

### Understanding Pipelines

A pipeline represents your sales process as stages:

**Default Stages:**
1. New Lead
2. Qualified
3. Proposal Sent
4. Negotiation
5. Won / Lost

### Customizing Pipelines

1. **Navigate to CRM Settings**
   - Click gear icon in CRM
   - Select "Pipeline Settings"

2. **Edit Stages**
   - Add new stages
   - Rename existing stages
   - Reorder stages
   - Set stage probabilities

3. **Multiple Pipelines**
   - Create pipelines for different products
   - Separate B2B and B2C pipelines
   - Industry-specific pipelines

### Working with Deals

#### Creating Deals

1. **Add New Deal**
   - Click "Add Deal" in CRM
   - Enter deal details:
     - Deal name
     - Contact/Company
     - Value
     - Expected close date
     - Pipeline and stage

2. **Deal Information**
   - Contact person
   - Company
   - Deal value
   - Currency
   - Products/services
   - Competitors

#### Moving Deals

- **Drag and Drop**: Move deal cards between stages
- **Update Stage**: Click deal and change stage
- **Bulk Move**: Select multiple deals to move together

#### Deal Views

- **Kanban Board**: Visual pipeline view
- **List View**: Sortable table view
- **Forecast View**: Revenue by close date

## Lead Management

### Capturing Leads

**Manual Entry:**
1. Click "Add Lead"
2. Enter lead information:
   - Name and contact
   - Source (Web, Referral, Event, etc.)
   - Interest/product
   - Initial notes

**Import Leads:**
- Upload CSV file
- Map columns to fields
- Assign to team members

### Lead Qualification

**Qualifying Criteria:**
- Budget confirmed
- Authority to decide
- Need identified
- Timeline defined

**Lead Scoring:**
- Assign points for activities
- Score based on fit
- Automatic prioritization

### Converting Leads

When lead is qualified:
1. Click "Convert to Deal"
2. Create associated contact
3. Create company (if B2B)
4. Set deal value and stage
5. Assign to sales rep

## Activities

### Activity Types

- **Calls**: Phone calls to make
- **Meetings**: Scheduled appointments
- **Emails**: Follow-up emails
- **Tasks**: General to-dos
- **Deadlines**: Important dates

### Scheduling Activities

1. **From Deal/Contact**
   - Open deal or contact
   - Click "Add Activity"
   - Select type and details
   - Set date/time
   - Save

2. **From Calendar**
   - Click on date
   - Choose activity type
   - Link to deal/contact

### Activity Tracking

- View today's activities
- See overdue items
- Complete and log outcomes
- Automatic history creation

### Calendar Integration

- View all activities on calendar
- Sync with Google Calendar
- Team calendar view
- Availability checking

## Customer 360

### Complete Customer View

For each contact/company:

**Timeline:**
- All interactions chronologically
- Emails, calls, meetings
- Deals and transactions
- Notes and documents

**Relationships:**
- Associated contacts
- Related companies
- Linked deals
- Connected projects

**Financial:**
- Invoices sent
- Payments received
- Outstanding balance
- Lifetime value

**Documents:**
- Contracts
- Proposals
- Correspondence
- Files shared

## Sales Reporting

### Pipeline Reports

- **Pipeline Value**: Total by stage
- **Conversion Rates**: Stage-to-stage conversion
- **Velocity**: Time in each stage
- **Leakage**: Where deals drop off

### Activity Reports

- Activities completed
- Activities by type
- Response times
- Team productivity

### Revenue Reports

- Won deals by period
- Revenue by source
- Revenue by product
- Team performance

### Forecasting

- Expected revenue by month
- Weighted pipeline value
- Probability-based forecast
- Goal tracking

## Best Practices

### Pipeline Hygiene

- Update deals regularly
- Move stale deals to "On Hold"
- Set realistic close dates
- Log all activities

### Lead Response

- Respond to new leads quickly
- Set follow-up reminders
- Document all conversations
- Score leads consistently

### Team Collaboration

- Assign clear ownership
- Hand off deals properly
- Share important notes
- Use @mentions in notes
    `
  },
  {
    id: "projects",
    title: "Project Management",
    icon: Briefcase,
    content: `
# Project Management

AccrualFlow Projects helps you manage projects, track progress, allocate resources, and bill clients accurately.

## Overview

### Project Features

- **Project Creation**: Define projects with details
- **Task Management**: Break down work into tasks
- **Time Tracking**: Log time against projects
- **Progress Tracking**: Monitor completion
- **Project Invoicing**: Bill time and expenses
- **Resource Planning**: Allocate team members

## Creating Projects

### New Project

1. **Navigate to Projects**
   - Click "Projects" in sidebar
   - Click "Add Project"

2. **Basic Information**
   - Project name
   - Client/customer
   - Description
   - Project code

3. **Timeline**
   - Start date
   - Target end date
   - Milestones

4. **Budget**
   - Project budget
   - Billable/non-billable
   - Billing method (Fixed, Hourly, Milestone)

5. **Team**
   - Project manager
   - Team members
   - Roles and responsibilities

### Project Settings

Configure per project:
- Time tracking enabled
- Expense tracking enabled
- Budget alerts
- Client visibility

## Task Management

### Creating Tasks

1. **Add Task**
   - Open project
   - Click "Add Task"
   - Enter task details:
     - Task name
     - Description
     - Assignee
     - Due date
     - Priority
     - Estimated hours

2. **Task Organization**
   - Group into phases/sections
   - Set dependencies
   - Add subtasks

### Task Status

Track task progress:
- **To Do**: Not started
- **In Progress**: Being worked on
- **In Review**: Awaiting approval
- **Done**: Completed

### Task Views

- **List View**: Traditional task list
- **Board View**: Kanban-style columns
- **Calendar View**: Tasks by due date
- **Timeline View**: Gantt-style view

## Time Tracking

### Logging Time

**From Timesheet:**
1. Go to Timesheets
2. Select project/task
3. Enter hours
4. Add description
5. Submit

**From Project:**
1. Open project
2. Click "Log Time"
3. Enter hours and details
4. Save

**Timer Method:**
1. Start timer on task
2. Work on task
3. Stop timer
4. Review and save

### Time Reports

- Time by project
- Time by team member
- Time by task
- Billable vs. non-billable

## Project Progress

### Progress Tracking

Monitor project health:
- Overall completion percentage
- Tasks completed vs. total
- Hours used vs. budget
- Timeline status

### Milestones

Set key checkpoints:
1. Create milestone
2. Link related tasks
3. Set target date
4. Track completion
5. Mark as achieved

### Status Updates

Regular project updates:
- Weekly status reports
- Progress notes
- Blockers and risks
- Next steps

## Project Invoicing

### Billing Methods

**Fixed Price:**
- Agreed project fee
- Invoice on milestones
- Or invoice on completion

**Time & Materials:**
- Bill actual hours worked
- Plus expenses incurred
- Regular invoicing (weekly/monthly)

**Milestone-Based:**
- Bill on milestone completion
- Defined amounts per milestone

### Creating Project Invoices

1. **Open Project**
2. **Click "Create Invoice"**
3. **Select Billing Items**
   - Unbilled time entries
   - Unbilled expenses
   - Milestone payments
4. **Review and Send**
   - Verify amounts
   - Add any adjustments
   - Send to client

### Expense Tracking

Log project expenses:
- Direct costs
- Contractor payments
- Materials purchased
- Travel expenses

## Resource Planning

### Team Allocation

- View team capacity
- See project assignments
- Identify overallocation
- Plan future resources

### Availability

- Team member availability
- Leave/time off
- Other project commitments
- Capacity planning

## Reporting

### Project Reports

- **Project Summary**: Overview of all projects
- **Project Detail**: Deep dive into single project
- **Time Analysis**: Hours breakdown
- **Budget Analysis**: Cost vs. budget
- **Profitability**: Revenue minus costs

### Portfolio View

See all projects:
- By status
- By client
- By project manager
- By department
    `
  },
  // Documents & Storage section retired 2026-05-16.
  {
    id: "ai-assistant",
    title: "AI Assistant",
    icon: Bot,
    content: `
# AI Assistant

AccrualFlow includes a built-in AI Assistant to help you navigate the platform, answer questions, and provide guidance.

## Accessing the AI Assistant

### Chat Button

Look for the chat bubble icon in the bottom-right corner of the screen. Click it to open the AI Assistant panel.

### When to Use

The AI Assistant can help with:
- How to use specific features
- Finding where things are located
- Understanding concepts and terminology
- Step-by-step guidance
- Troubleshooting issues
- Best practices and tips

## What the AI Can Help With

### Platform Navigation

**Ask questions like:**
- "How do I create a new invoice?"
- "Where can I find my payment methods settings?"
- "How do I add a new employee?"
- "Where are the POS settings?"

### Feature Guidance

**Get help with:**
- Setting up features for the first time
- Understanding how features work together
- Configuring settings correctly
- Following best practices

### Troubleshooting

**Common assistance:**
- "Why isn't my invoice sending?"
- "How do I fix a reconciliation difference?"
- "What do I do if my POS is offline?"
- "How do I correct a payment?"

### Process Explanations

**Understand workflows:**
- Invoice creation to payment flow
- Bill payment process
- Payroll processing steps
- Bank reconciliation workflow

## Example Conversations

### Creating an Invoice

**You:** How do I create my first invoice?

**AI:** To create your first invoice:
1. Click "Invoices" in the sidebar
2. Click "New Invoice" button
3. Select a customer (or create one)
4. Add line items for what you're billing
5. Review totals and payment terms
6. Click "Save & Send" to email it

Would you like me to explain any of these steps in more detail?

### Finding Settings

**You:** Where can I change my company logo?

**AI:** To change your company logo:
1. Go to Settings (gear icon or sidebar)
2. Click on "Business" or "Organization" tab
3. Find the "Logo" section
4. Click "Upload" to select a new logo
5. Save your changes

Your logo will appear on invoices and other documents.

### Understanding Features

**You:** What's the difference between an estimate and a proforma invoice?

**AI:** Great question! Here's the difference:

**Estimate:**
- A quotation or proposal
- Can be accepted/declined by customer
- Converts to invoice when approved
- Less formal, often used for services

**Proforma Invoice:**
- Pre-invoice document
- Used for customs/import purposes
- Also converts to invoice
- More formal, used internationally

Both can be converted to actual invoices with one click.

## Tips for Best Results

### Be Specific

Instead of: "Help with invoices"
Try: "How do I add a discount to an invoice line item?"

### Provide Context

If you're having an issue, describe:
- What you're trying to do
- What's happening instead
- Any error messages

### Ask Follow-ups

If you need more detail, ask follow-up questions:
- "Can you explain step 3 in more detail?"
- "What if I don't see that option?"
- "Is there a faster way to do this?"

## Limitations

The AI Assistant can help with:
✓ AccrualFlow features and navigation
✓ General business processes
✓ Best practice guidance
✓ Troubleshooting common issues

The AI Assistant cannot:
✗ Access your specific data
✗ Make changes to your account
✗ Process transactions
✗ Provide tax or legal advice

## Feedback

If the AI's answer wasn't helpful:
- Try rephrasing your question
- Contact human support for complex issues
- Report issues to help us improve

## Privacy

Your conversations with the AI:
- Are used to provide assistance
- May be used to improve the service
- Do not expose your business data
- Follow our privacy policy
    `
  },
  {
    id: "reports",
    title: "Reports & Analytics",
    icon: BarChart3,
    content: `
# Reports & Analytics

Make data-driven decisions with AccrualFlow's comprehensive reporting and analytics suite.

## Report Categories

### Financial Reports
Core financial statements for accounting and compliance.

### Sales Reports
Detailed analysis of revenue and sales performance.

### Tax Reports
Tax liability, collection, and filing assistance.

### Inventory Reports
Stock levels, movement, and valuation.

### Management Reports
Operational insights and KPIs.

## Financial Reports

### Profit & Loss Statement

Shows financial performance over a period.

**Contents:**
- **Revenue**: Sales income, service income, other income
- **Cost of Goods Sold**: Direct costs, inventory costs
- **Gross Profit**: Revenue minus COGS
- **Operating Expenses**: Salaries, rent, utilities, marketing
- **Operating Income**: Gross profit minus expenses
- **Net Profit/Loss**: Bottom line result

**Options:**
- Date range selection
- Comparison periods
- By business unit
- Export to PDF/Excel

### Balance Sheet

Financial position at a point in time.

**Assets:**
- Current Assets (cash, receivables, inventory)
- Non-Current Assets (fixed assets, investments)

**Liabilities:**
- Current Liabilities (payables, accrued expenses)
- Non-Current Liabilities (long-term loans)

**Equity:**
- Owner's capital
- Retained earnings
- Current year earnings

### Cash Flow Statement

Money movement analysis.

**Operating Activities:** Net income adjustments, working capital changes
**Investing Activities:** Asset purchases and sales
**Financing Activities:** Loans, owner contributions

### Trial Balance

All account balances for verification.
- Debit and credit columns
- Net balance column
- Filter by account type
- As of specific date

### General Ledger

Detailed transaction history by account.
- Single account detail
- All accounts summary
- Date range filter
- Transaction-level drill-down

## Sales Reports

### Sales Summary

High-level sales overview:
- Total sales
- Number of transactions
- Average transaction value
- Sales growth vs. prior period

### Sales by Customer

Customer contribution analysis:
- Top customers by revenue
- Customer frequency
- Average order value
- Payment behavior

### Sales by Product

Product performance:
- Best selling products
- Revenue by category
- Margin analysis
- Stock turn rates

### Accounts Receivable Aging

Outstanding customer balances by age:
- Current (not yet due)
- 1-30 days past due
- 31-60 days past due
- 61-90 days past due
- Over 90 days past due

## Tax Reports

### VAT/GST Report

Value-added tax summary:
- Output VAT (collected on sales)
- Input VAT (paid on purchases)
- Net VAT payable/receivable
- By tax rate breakdown

### Withholding Tax Report

Tax withheld from payments:
- Withholding by vendor
- Total withheld
- Filing deadlines
- Certificate generation

### eTIMS Reports (Kenya)

Tax authority compliance:
- Transmitted invoices
- Transmission status
- Failed transmissions
- Audit trail

## Inventory Reports

### Stock Level Report

Current inventory status:
- SKU and description
- Quantity on hand
- Quantity reserved
- Quantity available
- Low stock alerts

### Stock Valuation

Inventory value calculation using:
- FIFO, LIFO, or Weighted Average
- By product, category, or warehouse

### Stock Movement

Inventory transaction history:
- Receipts, issues, adjustments
- Opening/closing balances

## Business Intelligence

### AI-Powered Insights

AccrualFlow BI provides:
- Trend analysis
- Anomaly detection
- Predictive forecasting
- Natural language queries

### Custom Dashboards

Build your own dashboards:
- Drag and drop widgets
- Choose metrics to display
- Set refresh intervals
- Share with team

### Automated Reports

Schedule reports:
- Daily, weekly, monthly
- Email delivery
- PDF or Excel format
- Multiple recipients

## Export Options

### PDF Export
Professional, print-ready documents

### Excel Export
For further analysis with formulas preserved

### CSV Export
Universal compatibility for data import
    `
  },
  {
    id: "team",
    title: "Team & Permissions",
    icon: Users,
    content: `
# Team & Permissions

Manage your team members, roles, and access levels effectively.

## Inviting Team Members

### How to Invite

1. **Navigate to Team**
   - Go to Settings > Team
   - Or directly to Team page

2. **Click "Invite Member"**

3. **Enter Details**
   - Email address
   - Role assignment
   - Business access (if multi-business)

4. **Send Invitation**
   - Click "Send Invite"
   - Recipient receives email
   - Link valid for 7 days

### Invitation Process

1. Member receives email
2. Clicks invitation link
3. Creates account (if new) or links existing
4. Joins your organization
5. Gains access based on assigned role

## Role System

### Default Roles

#### Owner
Full control over the organization.
**Permissions:** Everything including billing, deleting organization

#### Administrator
Full operational access.
**Permissions:** All features except billing and organization deletion

#### Accountant
Financial management access.
**Permissions:** Full access to all financial modules, reports, settings

#### Sales Representative
Sales-focused access.
**Permissions:** Create invoices, estimates; view customer information

#### Cashier (POS)
Point of sale operations only.
**Permissions:** Process sales, handle returns (with limits), view own shift

#### Viewer (Read-Only)
Observation without changes.
**Permissions:** View transactions, reports; no create, edit, or delete

### Custom Roles

Create roles tailored to your needs:

1. **Create Role**
   - Go to Settings > Team > Roles
   - Click "Create Role"
   - Enter role name and description

2. **Set Permissions**
   For each module, select:
   - No Access
   - View Only
   - Create
   - Edit
   - Delete
   - Full Access

3. **Module Permissions**
   - Invoices, Estimates, Expenses
   - Bills, Banking, Contacts
   - Products, Reports, Settings
   - Team, POS, and more

## Permission System

### Permission Types

- **View**: See records in lists and details
- **Create**: Add new records
- **Edit**: Modify existing records
- **Delete**: Remove records
- **Approve**: Approve pending items

### Ownership-Based Access

- **Own records only**: User can only edit records they created
- **Team records**: Can edit records from team members
- **All records**: Full access regardless of creator

### Amount-Based Limits

Set financial thresholds:
- Maximum invoice amount
- Maximum discount percentage
- Maximum approval limit
- Expense approval threshold

## Managing Users

### Viewing Team

The Team page shows:
- User name and email
- Assigned role
- Status (active, pending, suspended)
- Last login
- Action buttons

### Editing Users

1. Click on user
2. Modify role assignment, business access, or specific permissions
3. Save changes

### Deactivating Users

When someone leaves:
- **Suspend**: User cannot login, data preserved, can be reactivated
- **Remove**: Access revoked permanently, records remain for audit

## Security Features

### Session Management
- Session timeout (configurable)
- Device management
- Active session visibility

### Two-Factor Authentication
- Email codes or authenticator apps
- Backup codes
- Per-user enforcement

### Audit Trail
All actions logged with user, timestamp, and changes

## Multi-Business Access

### Cross-Business Access
For organizations with multiple businesses:
- Assign specific businesses user can access
- Set per-business roles if needed
- Configure default workspace

### Business Switching
Users with multi-business access can:
- See business switcher in header
- Select active business
- Permissions apply per-business
    `
  },
  {
    id: "settings",
    title: "Settings & Configuration",
    icon: Settings,
    content: `
# Settings & Configuration

Customize AccrualFlow to match your business requirements exactly.

## Business Settings

### Company Information

1. **Business Identity**
   - Trading name
   - Legal/registered name
   - Registration number
   - Tax ID (PIN, VAT number)

2. **Contact Details**
   - Address (appears on documents)
   - Phone number
   - Email address
   - Website

3. **Branding**
   - Logo upload (recommended: 400x400px PNG)
   - Primary brand color
   - These appear on invoices and emails

### Fiscal Settings

1. **Financial Year**
   - Start month
   - First fiscal year
   - Year naming convention

2. **Accounting Method**
   - Accrual basis
   - Cash basis

## Document Settings

### Invoice Configuration

1. **Numbering**
   - Prefix (e.g., "INV-")
   - Include year in number
   - Starting number

2. **Defaults**
   - Default payment terms
   - Default tax rate
   - Default notes/terms

### Document Templates

Customize appearance:
- Multiple template designs
- Header/footer customization
- Column visibility
- Payment method selection
- Logo placement and colors

Configure in Settings > Templates

## Payment Methods

### Configure Payment Options

Navigate to Settings > Payment Methods:

1. **Bank Accounts**
   - Add multiple accounts
   - Include SWIFT/IBAN
   - Link to banking module

2. **Mobile Money**
   - M-Pesa Paybill/Till
   - QR code generation
   - Account reference format

3. **Online Payments**
   - PayPal, Stripe
   - Payment links

4. **Other Methods**
   - Cash instructions
   - Custom methods

### Per-Template Selection

Choose which methods appear on each document type.

## Tax Configuration

### Tax Rates

1. **Creating Tax Rates**
   - Name (e.g., "VAT 16%")
   - Rate percentage
   - Is compound (tax on tax)
   - Is inclusive

2. **Default Rates**
   - Default sales tax
   - Default purchase tax

### Tax Compliance

#### eTIMS (Kenya)

1. **Enable eTIMS**
   - Enter TIN
   - Configure API credentials
   - Test connection

2. **Settings**
   - Auto-transmit on send
   - Retry on failure
   - Notification preferences

## Currency Settings

### Base Currency
- Primary operating currency
- All reports in base currency

### Additional Currencies
- Add currencies
- Exchange rate sources
- Auto-update options

## Email Settings

### Sender Configuration
- From name
- Reply-to address
- Email signature

### Templates
Customize templates for:
- Invoice sending
- Payment reminders
- Estimate follow-ups
- Welcome emails

### SMTP (Optional)
Use your own email server:
- SMTP host and port
- Authentication
- TLS/SSL settings

## Notifications

### Configure Alerts

Choose notifications for:
- Payment received
- Invoice overdue
- Low stock alerts
- Approval requests
- Team mentions

### Delivery Methods
- In-app notifications
- Email notifications
- Push notifications (mobile)

## Data & Privacy

### Data Export
Export all your data:
- Go to Settings > Data
- Click "Export All Data"
- Download comprehensive backup

### Account Deletion
To delete your organization:
- Export data first
- Go to Settings > Organization
- Click "Delete Organization"
- Confirm with password
    `
  },
  {
    id: "security",
    title: "Security & Privacy",
    icon: Shield,
    content: `
# Security & Privacy

AccrualFlow implements enterprise-grade security to protect your sensitive financial data.

## Security Architecture

### Defense in Depth

Multiple security layers:

1. **Network Security**
   - TLS 1.3 encryption in transit
   - DDoS protection
   - Web Application Firewall
   - IP-based rate limiting

2. **Application Security**
   - Secure authentication
   - Session management
   - Input validation
   - CSRF protection

3. **Data Security**
   - AES-256 encryption at rest
   - Key management
   - Data isolation
   - Secure backups

4. **Access Control**
   - Role-based permissions
   - Row-level security
   - Principle of least privilege
   - Audit logging

## Authentication

### Login Security

1. **Password Requirements**
   - Minimum 8 characters
   - Mixed case letters
   - At least one number

2. **Account Protection**
   - Account lockout after failed attempts
   - Unlock after timeout or admin reset
   - Unusual activity detection

### Two-Factor Authentication (2FA)

Extra verification layer:
- Time-based codes (TOTP)
- Email verification codes
- Backup codes

### Session Management

- Configurable timeout
- Single session option
- Device management
- Active session visibility

## Authorization

### Role-Based Access Control (RBAC)

Every action requires:
- Authentication (who you are)
- Authorization (what you can do)
- Scope (which data you can access)

### Row-Level Security (RLS)

Database-level isolation:
- Every query filtered by organization
- Users only see their organization's data
- Enforced at database level

## Data Protection

### Encryption

**At Rest:** AES-256 encryption
**In Transit:** TLS 1.3 for all connections

### Data Isolation

- Separate data per organization
- No cross-organization access
- API filtering
- Query restrictions

## Audit & Monitoring

### Audit Logging

All actions logged:
- User identity
- Action performed
- Affected records
- Timestamp and IP address
- Before/after values

### Viewing Audit Logs

1. Navigate to Audit Logs
2. Filter by date, user, action type
3. View details
4. Export for analysis

## Compliance

### Regulatory Compliance

- GDPR (EU)
- Local data protection laws
- OWASP Top 10 protection
- ISO 27001 alignment

## Privacy Features

### User Rights

**Access Rights:** View and export all your data
**Control Rights:** Correct, delete, or restrict data

### Data Export

Export all your data in machine-readable format anytime.

### Account Deletion

Complete data removal within 30 days of request.

## Security Best Practices

### For Administrators

- Review user access quarterly
- Remove unused accounts
- Enable 2FA for all users
- Set appropriate session timeouts
- Review audit logs regularly

### For Users

- Use unique, strong passwords
- Use a password manager
- Lock devices when away
- Report suspicious activity
    `
  },
  {
    id: "integrations",
    title: "Integrations",
    icon: Globe,
    content: `
# Integrations

Extend AccrualFlow's capabilities by connecting with other tools and services.

## Available Integrations

### Banking Integrations

Connect your bank accounts for automatic transaction import:
- Major banks via Open Banking
- International banks via Plaid
- CSV import (universal)

### Payment Processors

#### M-Pesa Integration (Kenya)

**STK Push (Lipa Na M-Pesa):**
- Initiate payment from AccrualFlow
- Customer confirms on phone
- Automatic payment recording

**C2B (Customer to Business):**
- Paybill or Till number
- Customers pay directly
- Automatic matching

#### Card Payments

**Stripe/PayPal Integration:**
- Accept cards online
- Payment links on invoices
- Automatic reconciliation

### Tax Authority Integrations

#### eTIMS (Kenya Revenue Authority)

- Real-time invoice transmission
- CU number assignment
- QR code generation
- Digital signature
- Credit note transmission

### E-commerce Platforms

Connect your online store:
- **WooCommerce**: Sync orders, products, customers
- **Shopify**: Import sales, manage inventory
- **Magento**: Enterprise e-commerce integration
- **Custom API**: Build your own integration

### Email Services

**Built-in Email:** Ready to use with basic branding
**Custom SMTP:** Use your email server for full control

## API Access

### REST API

Full programmatic access:
- Base URL: https://api.accrualflow.com/v1
- API key authentication
- OAuth 2.0 for user context
- Rate limiting applied

### Webhooks

Receive real-time notifications for:
- Invoice created/sent/paid
- Payment received
- Customer created/updated
- Low stock alerts

## Zapier Integration

Connect AccrualFlow with 5000+ apps:
- Gmail → AccrualFlow: Create contact from email
- AccrualFlow → Slack: Notify on new invoice
- AccrualFlow → Google Sheets: Log transactions

## Data Import/Export

### CSV Import

Import existing data:
- Contacts (customers/vendors)
- Products
- Opening balances
- Bank transactions

### Data Export

Export your data anytime:
- CSV for spreadsheets
- PDF for documents
- JSON for developers
- Excel for analysis
    `
  },
  {
    id: "mobile",
    title: "Mobile Access",
    icon: Smartphone,
    content: `
# Mobile Access

Access AccrualFlow on the go with our mobile-optimized experience.

## Mobile Web App

AccrualFlow is fully responsive and works on any mobile device.

### Accessing on Mobile

1. Open your mobile browser
2. Navigate to app.accrualflow.com
3. Login with your credentials
4. Bookmark for quick access

### Add to Home Screen

**iOS (Safari):**
1. Open AccrualFlow in Safari
2. Tap the Share button
3. Select "Add to Home Screen"
4. Name the shortcut
5. Tap Add

**Android (Chrome):**
1. Open AccrualFlow in Chrome
2. Tap the menu (three dots)
3. Select "Add to Home Screen"
4. Name the shortcut
5. Tap Add

### Mobile Features

All features available:
- Dashboard overview
- Create and send invoices
- Record payments
- View reports
- Manage contacts
- POS operations

## Mobile POS

Use your phone or tablet as a POS terminal:

- Product search and selection
- Camera-based barcode scanning
- Customer lookup
- Payment processing
- Receipt options
- Offline support

## Offline Capabilities

### What Works Offline

- View cached data
- Create transactions (queued)
- POS operations
- View cached reports

### Syncing

- Automatic sync when online
- Manual sync option
- Conflict resolution
- Sync status indicator

## Mobile Security

### Best Practices

- Use device lock (PIN, biometric)
- Enable auto-logout
- Clear cache if device lost
- Use trusted networks
- Enable 2FA
    `
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: HelpCircle,
    content: `
# Troubleshooting Guide

Solutions to common issues and how to get help when needed.

## Common Issues

### Login Problems

**Can't Login:**
1. Verify email address is correct
2. Check password (case-sensitive)
3. Clear browser cache and cookies
4. Try incognito/private mode
5. Reset password if needed

**Account Locked:**
- Wait 30 minutes for auto-unlock
- Or contact support for immediate unlock

**2FA Issues:**
1. Ensure device time is correct
2. Try backup codes
3. Contact support with identity verification

### Performance Issues

**Slow Loading:**
1. Check internet connection
2. Clear browser cache
3. Try different browser
4. Disable browser extensions

**Timeouts:**
1. Reduce data scope
2. Export in smaller batches

### Invoice Issues

**Invoice Not Sending:**
1. Verify customer email
2. Check email settings
3. Look in spam/junk folder
4. Check email delivery logs

**PDF Generation Fails:**
1. Refresh page
2. Clear browser cache
3. Check for special characters

### Payment Issues

**Payment Not Recording:**
1. Check for duplicate
2. Verify invoice is not voided
3. Ensure correct currency
4. Check permissions

### POS Issues

**Register Not Opening:**
1. Check user permissions
2. Verify register is active
3. Clear browser cache

**Offline Mode Problems:**
1. Ensure offline mode is enabled
2. Check local storage space
3. Clear and re-sync

**Printer Not Working:**
1. Check printer connection
2. Test print from settings
3. Verify paper width setting

### Bank Connection Issues

**Transactions Not Syncing:**
1. Check sync status
2. Verify date range
3. Manually trigger sync

### eTIMS Issues

**Transmission Failed:**
1. Check TIN credentials
2. Verify API connectivity
3. Review error message
4. Retry transmission

## Error Messages

### Understanding Error Codes

**4xx Errors (Client):**
- 400: Bad request - check your input
- 401: Unauthorized - login again
- 403: Forbidden - check permissions
- 404: Not found - resource doesn't exist

**5xx Errors (Server):**
- 500: Server error - try again later
- 503: Service unavailable - maintenance

## Getting Help

### Self-Service Resources

1. **Documentation** (you're reading it!)
2. **Help Center** - FAQs and videos
3. **AI Assistant** - Click chat bubble for instant help

### Contact Support

**Email:** support@accrualflow.com
**Response:** Within 24 hours (business days)

When contacting support, include:
- What you were trying to do
- What happened instead
- Error messages (exact text)
- Browser and device info
- Screenshots if possible

## Status Page

Check system status at status.accrualflow.com for:
- Real-time updates
- Incident history
- Maintenance schedule
    `
  }
];

export default docSections;
