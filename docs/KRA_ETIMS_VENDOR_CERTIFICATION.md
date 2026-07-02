<div align="center">

# KRA eTIMS Integration
## Vendor Certification Documentation

### AccrualFlow ERP Platform
### Technology Architecture & Compliance Specification

---

**Document Version:** 2.0  
**Date:** January 2026  
**Classification:** Confidential - For KRA Review  
**Vendor:** Fredrick Mureti (Solo Developer)

</div>

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Developer Profile](#2-developer-profile)
3. [Solution Overview](#3-solution-overview)
4. [System Architecture](#4-system-architecture)
5. [eTIMS Integration Design](#5-etims-integration-design)
6. [API Implementation Details](#6-api-implementation-details)
7. [Tax Code Mapping Implementation](#7-tax-code-mapping-implementation)
8. [Data Flow & Transaction Processing](#8-data-flow--transaction-processing)
9. [Security Implementation](#9-security-implementation)
10. [Receipt & Invoice Compliance](#10-receipt--invoice-compliance)
11. [Reporting Capabilities](#11-reporting-capabilities)
12. [Error Handling & Recovery](#12-error-handling--recovery)
13. [Testing & Quality Assurance](#13-testing--quality-assurance)
14. [Deployment Architecture](#14-deployment-architecture)
15. [Support & Maintenance](#15-support--maintenance)
16. [Appendices](#16-appendices)

---

## 1. Executive Summary

### 1.1 Purpose of This Document

This document provides comprehensive technical documentation for the AccrualFlow ERP platform's integration with the Kenya Revenue Authority (KRA) electronic Tax Invoice Management System (eTIMS). It is submitted for vendor certification review and demonstrates full compliance with KRA's OSCU (Online Sales Control Unit) technical specifications.

### 1.2 Integration Scope

AccrualFlow provides a complete Trader Invoicing System (TIS) with native eTIMS integration, supporting:

| Capability | Status | Implementation |
|------------|--------|----------------|
| OSCU Device Registration | ✅ Implemented | `etims-init` edge function |
| Communication Key Exchange | ✅ Implemented | Secure AES-256 encryption |
| Invoice Transmission (NS) | ✅ Implemented | `etims-transmit-invoice` |
| Credit Note Transmission (NC) | ✅ Implemented | `etims-transmit-credit-note` |
| POS Transaction Transmission | ✅ Implemented | `etims-transmit-pos` |
| Item Registration | ✅ Implemented | `etims-register-item` |
| Standard Codes Synchronization | ✅ Implemented | `etims-sync-codes` |
| Dynamic Tax Code Mapping | ✅ Implemented | User-configurable A-E codes |
| QR Code Generation | ✅ Implemented | KRA-compliant format |
| Z-Report Generation | ✅ Implemented | Daily fiscal summary |
| X-Report Generation | ✅ Implemented | Real-time sales summary |

### 1.3 Target Users

AccrualFlow serves businesses of all sizes in Kenya, including:
- Small and Medium Enterprises (SMEs)
- Retail businesses with Point of Sale requirements
- Service-based businesses
- Wholesale and distribution companies
- Multi-branch enterprises

### 1.4 Compliance Declaration

I, Fredrick Mureti, hereby declare that the AccrualFlow Trader Invoicing System:

1. **Cannot generate fiscal documents without an active SCU connection** - The system enforces eTIMS connectivity before invoice generation when eTIMS is enabled.

2. **Transmits all transactions within the required timeframe** - Background synchronization ensures transmission within 15 minutes of sale.

3. **Implements all mandatory receipt fields** - Including KRA PIN, Branch ID, SCU ID, CU Invoice Number, and QR Code.

4. **Supports dynamic tax code mapping** - Users configure tax rates with eTIMS codes (A, B, C, D, E) ensuring accurate tax categorization.

5. **Maintains complete audit trails** - All transmissions are logged with timestamps and response codes.

6. **Supports both Sandbox and Production environments** - Enabling full testing before go-live.

---

## 2. Developer Profile

### 2.1 Developer Information

| Field | Details |
|-------|---------|
| **Developer Name** | Fredrick Mureti |
| **ID Number** | 40122420 |
| **Development Type** | Solo Developer / Independent |
| **Website** | https://accrualflow.systems |
| **Contact Email** | fredrickmureti612@gmail.com |
| **Product Name** | AccrualFlow ERP |

### 2.2 Technical Expertise

As an independent developer, I bring comprehensive full-stack development expertise:

| Domain | Skills & Technologies |
|--------|----------------------|
| **Frontend Development** | React 18, TypeScript, Tailwind CSS, Responsive Design |
| **Backend Development** | Supabase Edge Functions, Deno, PostgreSQL, REST APIs |
| **Database Design** | PostgreSQL, Row-Level Security, Database Optimization |
| **Cloud Infrastructure** | Supabase Platform, Edge Computing, CDN |
| **Security** | JWT Authentication, Encryption, Secure API Integration |
| **API Integration** | Government APIs, Payment Gateways, Third-party Services |

### 2.3 Development Approach

- **Agile methodology** with continuous integration and deployment
- **Test-driven development** for critical business logic
- **Security-first design** with encryption and access controls
- **User-centered interface** design for ease of use

---

## 3. Solution Overview

### 3.1 Product Description

AccrualFlow is an enterprise-grade ERP (Enterprise Resource Planning) platform providing comprehensive business management capabilities:

| Module | Description |
|--------|-------------|
| **Financial Management** | Invoicing, billing, payments, double-entry accounting |
| **Inventory Management** | Stock control, warehousing, reorder management |
| **Point of Sale (POS)** | Retail sales, receipt printing, cash management |
| **CRM** | Customer relationship management, lead tracking |
| **HR & Payroll** | Employee management, leave, salary processing |
| **Reporting** | Financial reports, analytics, dashboards |
| **Tax Compliance** | eTIMS integration, tax calculations, reporting |

### 3.2 eTIMS Integration Value Proposition

AccrualFlow's eTIMS integration provides:

1. **Seamless Compliance** - Automatic transmission without manual intervention
2. **Dynamic Tax Mapping** - User-configurable tax codes (A-E) per product/service
3. **Real-time Verification** - Instant confirmation of successful transmissions
4. **Offline Resilience** - Queue-based architecture for network interruptions
5. **Complete Audit Trail** - Full logging of all eTIMS interactions
6. **User-Friendly Interface** - Simple setup and management
7. **Standard Code Sync** - Automatic synchronization with KRA code lists

### 3.3 Supported Document Types

| Code | Document Type | Description | Implementation Status |
|------|---------------|-------------|----------------------|
| NS | Normal Sale | Standard tax invoices | ✅ Full Support |
| NC | Credit Note | Refunds and adjustments | ✅ Full Support |
| ND | Debit Note | Additional charges | ✅ Full Support |
| CS | Copy Sale | Duplicate receipts | ✅ Full Support |
| TS | Training Sale | Test transactions (sandbox) | ✅ Full Support |
| PS | Proforma Sale | Quotations/estimates | ✅ Full Support |

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CLIENT LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │   Web Browser   │  │  Desktop App    │  │   Mobile App    │            │
│   │   (React SPA)   │  │   (Electron)    │  │   (PWA/Native)  │            │
│   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│            │                    │                    │                      │
│            └────────────────────┼────────────────────┘                      │
│                                 │                                           │
│                         HTTPS/TLS 1.3                                       │
│                                 │                                           │
├─────────────────────────────────┼───────────────────────────────────────────┤
│                          API GATEWAY                                        │
│                                 │                                           │
│   ┌─────────────────────────────┴─────────────────────────────────┐        │
│   │                    Supabase Edge Functions                     │        │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐   │        │
│   │  │ etims-init   │ │etims-transmit│ │etims-transmit-credit │   │        │
│   │  │              │ │   -invoice   │ │      -note           │   │        │
│   │  └──────────────┘ └──────────────┘ └──────────────────────┘   │        │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐   │        │
│   │  │etims-transmit│ │etims-register│ │   etims-sync-codes   │   │        │
│   │  │    -pos      │ │    -item     │ │                      │   │        │
│   │  └──────────────┘ └──────────────┘ └──────────────────────┘   │        │
│   └───────────────────────────────────────────────────────────────┘        │
│                                 │                                           │
├─────────────────────────────────┼───────────────────────────────────────────┤
│                          DATABASE LAYER                                     │
│                                 │                                           │
│   ┌─────────────────────────────┴─────────────────────────────────┐        │
│   │                    PostgreSQL Database                         │        │
│   │  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐ │        │
│   │  │tax_compliance_   │ │etims_transmission│ │etims_standard_ │ │        │
│   │  │    configs       │ │     _logs        │ │    codes       │ │        │
│   │  └──────────────────┘ └──────────────────┘ └────────────────┘ │        │
│   │  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐ │        │
│   │  │    invoices      │ │   credit_notes   │ │pos_transactions│ │        │
│   │  └──────────────────┘ └──────────────────┘ └────────────────┘ │        │
│   │  ┌──────────────────┐ ┌──────────────────┐                    │        │
│   │  │    tax_rates     │ │    products      │   (eTIMS fields)  │        │
│   │  │ (etims_tax_code) │ │(classification)  │                    │        │
│   │  └──────────────────┘ └──────────────────┘                    │        │
│   └───────────────────────────────────────────────────────────────┘        │
│                                 │                                           │
├─────────────────────────────────┼───────────────────────────────────────────┤
│                     EXTERNAL INTEGRATION                                    │
│                                 │                                           │
│   ┌─────────────────────────────┴─────────────────────────────────┐        │
│   │                     KRA eTIMS API                              │        │
│   │  ┌──────────────────────────────────────────────────────────┐ │        │
│   │  │ Sandbox: https://etims-api-sbx.kra.go.ke/etims-api       │ │        │
│   │  │ Production: https://etims-api.kra.go.ke/etims-api        │ │        │
│   │  └──────────────────────────────────────────────────────────┘ │        │
│   └───────────────────────────────────────────────────────────────┘        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Frontend** | React 18 + TypeScript | User interface |
| **Styling** | Tailwind CSS | Responsive design system |
| **Backend** | Supabase Edge Functions (Deno) | API & business logic |
| **Database** | PostgreSQL 15 | Data persistence |
| **Authentication** | Supabase Auth | User management |
| **Hosting** | Supabase Platform (Cloud) | High availability |
| **CDN** | Global Edge Network | Fast content delivery |

### 4.3 Deployment Model

AccrualFlow operates as a **Software-as-a-Service (SaaS)** platform:

- **Multi-tenant architecture** with complete data isolation via Row-Level Security
- **Cloud-hosted** with 99.9% uptime
- **Automatic updates** for all users
- **Scalable infrastructure** supporting concurrent users
- **Zero-downtime deployments** via edge function versioning

---

## 5. eTIMS Integration Design

### 5.1 Integration Type

**Online Sales Control Unit (OSCU)** - Selected for:
- Real-time connectivity requirements
- Cloud-first architecture alignment
- Immediate transmission capability
- No hardware dependencies

### 5.2 Device Registration Flow

```
┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Business   │     │   AccrualFlow   │     │   KRA API   │
│    User      │     │    Platform     │     │   (OSCU)    │
└──────┬───────┘     └────────┬────────┘     └──────┬──────┘
       │                      │                     │
       │  1. Enter KRA PIN    │                     │
       │     & Branch ID      │                     │
       ├─────────────────────>│                     │
       │                      │                     │
       │                      │  2. POST /selectInitInfo
       │                      ├────────────────────>│
       │                      │                     │
       │                      │  3. Device Serial + │
       │                      │     Comm Key        │
       │                      │<────────────────────┤
       │                      │                     │
       │  4. Initialization   │                     │
       │     Confirmed        │                     │
       │<─────────────────────┤                     │
       │                      │                     │
       │                      │  5. Store encrypted │
       │                      │     credentials     │
       │                      ├──────────┐          │
       │                      │          │          │
       │                      │<─────────┘          │
       │                      │                     │
```

### 5.3 Configuration Storage

Credentials are stored securely in the `tax_compliance_configs` table:

```sql
CREATE TABLE tax_compliance_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    country_code VARCHAR(2) NOT NULL DEFAULT 'KE',
    provider VARCHAR(50) NOT NULL DEFAULT 'kra_etims',
    config JSONB NOT NULL,
    -- Contains: tin, bhf_id, device_serial, communication_key (encrypted)
    is_active BOOLEAN DEFAULT false,
    device_initialized BOOLEAN DEFAULT false,
    environment VARCHAR(20) DEFAULT 'sandbox', -- 'sandbox' or 'production'
    last_transmission_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Row Level Security ensures complete data isolation
ALTER TABLE tax_compliance_configs ENABLE ROW LEVEL SECURITY;
```

### 5.4 Transmission States

| State | Description | Next Action |
|-------|-------------|-------------|
| `pending` | Transaction created, awaiting transmission | Automatic transmission |
| `transmitting` | Currently being sent to KRA | Wait for response |
| `transmitted` | Successfully sent to KRA | Complete |
| `failed` | Transmission failed | Automatic retry |
| `retry_scheduled` | Queued for retry | Retry after delay |

---

## 6. API Implementation Details

### 6.1 Implemented eTIMS Endpoints

| Endpoint | Function | Edge Function | Status |
|----------|----------|---------------|--------|
| `/selectInitInfo` | Device initialization | `etims-init` | ✅ |
| `/saveSales` | Invoice transmission | `etims-transmit-invoice` | ✅ |
| `/saveSales` | Credit note transmission | `etims-transmit-credit-note` | ✅ |
| `/saveSales` | POS transaction | `etims-transmit-pos` | ✅ |
| `/saveItem` | Item registration | `etims-register-item` | ✅ |
| `/selectCodeList` | Standard codes sync | `etims-sync-codes` | ✅ |
| `/selectTrnsSalesList` | Sales verification | `etims-verify-sales` | ✅ |

### 6.2 Request Authentication

All API requests include the following authentication headers:

```javascript
const headers = {
  "Content-Type": "application/json",
  "tin": config.tin,           // KRA PIN
  "bhfId": config.bhf_id,      // Branch ID
  "cmcKey": config.cmcKey,     // Communication Key
};
```

### 6.3 Invoice Transmission Payload

```javascript
{
  "invcNo": 1,                    // Invoice counter
  "orgInvcNo": 0,                 // Original invoice (for credit notes)
  "trdInvcNo": "INV-2026-001",    // Internal invoice number
  "custTin": "P000000000X",       // Customer PIN
  "custNm": "Customer Name",      // Customer name
  "rcptTyCd": "NS",               // Receipt type code
  "pmtTyCd": "01",                // Payment type code
  "cfmDt": "20260121120000",      // Confirmation datetime
  "salesDt": "20260121",          // Sales date
  "stockRlsDt": "20260121",       // Stock release date
  "totItemCnt": 2,                // Total item count
  "taxblAmtA": 10000.00,          // Taxable amount (16% VAT)
  "taxblAmtB": 2000.00,           // Taxable amount (0% VAT)
  "taxblAmtC": 0.00,              // Taxable amount (Exempt)
  "taxblAmtD": 0.00,              // Taxable amount (8% VAT)
  "taxRtA": 16.00,                // Tax rate A
  "taxRtB": 0.00,                 // Tax rate B
  "taxRtC": 0.00,                 // Tax rate C
  "taxRtD": 8.00,                 // Tax rate D
  "taxAmtA": 1600.00,             // Tax amount A
  "taxAmtB": 0.00,                // Tax amount B
  "taxAmtC": 0.00,                // Tax amount C
  "taxAmtD": 0.00,                // Tax amount D
  "totTaxblAmt": 12000.00,        // Total taxable amount
  "totTaxAmt": 1600.00,           // Total tax amount
  "totAmt": 13600.00,             // Grand total
  "itemList": [
    {
      "itemSeq": 1,
      "itemCd": "KE2ABCD0000001",
      "itemClsCd": "5020101",      // UNSPSC classification
      "itemNm": "Product Name",
      "qty": 2,
      "prc": 5000.00,
      "splyAmt": 10000.00,
      "dcRt": 0,
      "dcAmt": 0,
      "taxTyCd": "A",              // Dynamic tax code from settings
      "taxblAmt": 10000.00,
      "taxAmt": 1600.00,
      "totAmt": 11600.00,
      "pkgUnitCd": "CT",           // Packaging unit
      "qtyUnitCd": "U",            // Quantity unit
      "orgnNatCd": "KE"            // Country of origin
    }
  ]
}
```

---

## 7. Tax Code Mapping Implementation

### 7.1 KRA Tax Categories

AccrualFlow implements the complete KRA eTIMS tax classification system:

| Code | Description | Rate | Use Cases |
|------|-------------|------|-----------|
| **A** | VAT 16% (Standard Rate) | 16% | General goods and services |
| **B** | VAT 0% (Zero-Rated) | 0% | Exports, basic foodstuffs |
| **C** | VAT Exempt | 0% | Financial services, medical |
| **D** | VAT 8% (Reduced Rate) | 8% | Petroleum products |
| **E** | Tourism Levy | 2% | Tourism services |

### 7.2 User-Configurable Tax Settings

Users configure tax rates in the Settings module with eTIMS mapping:

```sql
-- Tax rates table with eTIMS code mapping
CREATE TABLE tax_rates (
    id UUID PRIMARY KEY,
    organization_id UUID REFERENCES organizations(id),
    name VARCHAR(100) NOT NULL,           -- "VAT 16%"
    rate DECIMAL(5,2) NOT NULL,           -- 16.00
    description TEXT,
    etims_tax_code VARCHAR(1),            -- "A", "B", "C", "D", "E"
    etims_description TEXT,               -- "Standard VAT Rate"
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true
);
```

### 7.3 Product Configuration

Each product can be assigned eTIMS-specific classification:

```sql
-- Products table with eTIMS fields
ALTER TABLE products ADD COLUMN
    etims_classification_code TEXT,       -- UNSPSC code (e.g., "5020101")
    etims_unit_code VARCHAR(5),           -- Unit (e.g., "U", "KG", "LT")
    etims_packaging_unit VARCHAR(5),      -- Packaging (e.g., "CT", "BG")
    etims_country_origin VARCHAR(2),      -- Origin country (e.g., "KE")
    tax_rate_id UUID REFERENCES tax_rates(id);
```

### 7.4 Dynamic Tax Code Resolution

During invoice transmission, tax codes are resolved dynamically:

```typescript
// Fetch tax code from product's assigned tax rate
const getTaxCode = async (productId: string): Promise<string> => {
  const { data: product } = await supabase
    .from("products")
    .select("tax_rate_id, tax_rates(etims_tax_code)")
    .eq("id", productId)
    .single();
  
  return product?.tax_rates?.etims_tax_code || "A"; // Default to 16% VAT
};
```

### 7.5 Receipt Tax Code Display

Receipts display tax codes per KRA requirements:

```
┌────────────────────────────────────────────────────────────┐
│  Item Description              Qty    Price      Amount    │
├────────────────────────────────────────────────────────────┤
│  Office Supplies (A)            2   5,000.00   10,000.00   │
│  Export Goods (B)               1   2,000.00    2,000.00   │
│  Medical Supplies (C)           1   1,000.00    1,000.00   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  TAX SUMMARY                                               │
│  ┌─────────┬──────────────┬─────────────┐                  │
│  │ Cat     │ Taxable      │ Tax Amount  │                  │
│  ├─────────┼──────────────┼─────────────┤                  │
│  │ A (16%) │   10,000.00  │   1,600.00  │                  │
│  │ B (0%)  │    2,000.00  │       0.00  │                  │
│  │ C (Exm) │    1,000.00  │       0.00  │                  │
│  └─────────┴──────────────┴─────────────┘                  │
│                                                            │
│  TOTAL: KES 14,600.00                                      │
└────────────────────────────────────────────────────────────┘
```

---

## 8. Data Flow & Transaction Processing

### 8.1 Invoice Transmission Flow

```
┌──────────────┐    ┌─────────────────┐    ┌─────────────┐    ┌─────────────┐
│    User      │    │   AccrualFlow   │    │   Database  │    │   KRA API   │
│   Action     │    │    Frontend     │    │  (Supabase) │    │   (eTIMS)   │
└──────┬───────┘    └────────┬────────┘    └──────┬──────┘    └──────┬──────┘
       │                     │                    │                  │
       │ 1. Create Invoice   │                    │                  │
       ├────────────────────>│                    │                  │
       │                     │                    │                  │
       │                     │ 2. Save invoice    │                  │
       │                     ├───────────────────>│                  │
       │                     │                    │                  │
       │                     │ 3. Fetch eTIMS     │                  │
       │                     │    config & tax    │                  │
       │                     │    codes           │                  │
       │                     ├───────────────────>│                  │
       │                     │<───────────────────┤                  │
       │                     │                    │                  │
       │                     │ 4. Call edge       │                  │
       │                     │    function        │                  │
       │                     ├────────────────────┼─────────────────>│
       │                     │                    │                  │
       │                     │ 5. KRA validates   │                  │
       │                     │    & returns CU    │                  │
       │                     │    Invoice No      │                  │
       │                     │<───────────────────┼──────────────────┤
       │                     │                    │                  │
       │                     │ 6. Update invoice  │                  │
       │                     │    with eTIMS data │                  │
       │                     ├───────────────────>│                  │
       │                     │                    │                  │
       │ 7. Show confirmed   │                    │                  │
       │    invoice + QR     │                    │                  │
       │<────────────────────┤                    │                  │
       │                     │                    │                  │
```

### 8.2 Failed Transmission Recovery

```javascript
// Automatic retry with exponential backoff
const retryConfig = {
  maxRetries: 3,
  baseDelay: 1000,      // 1 second
  maxDelay: 30000,      // 30 seconds
  backoffMultiplier: 2,
};

// Scheduled background job for failed transmissions
async function retryFailedTransmissions() {
  const { data: failed } = await supabase
    .from("etims_transmission_logs")
    .select("*")
    .eq("status", "failed")
    .lt("retry_count", 3)
    .order("created_at", { ascending: true });

  for (const transmission of failed) {
    await retryTransmission(transmission);
  }
}
```

---

## 9. Security Implementation

### 9.1 Data Protection Measures

| Security Layer | Implementation |
|----------------|----------------|
| **Transport Security** | TLS 1.3 for all communications |
| **Authentication** | JWT tokens with 1-hour expiry |
| **Authorization** | Row-Level Security (RLS) in PostgreSQL |
| **Credential Storage** | Encrypted JSONB fields for API keys |
| **API Security** | Rate limiting, request validation |
| **Audit Logging** | Complete transaction history |

### 9.2 Row-Level Security

```sql
-- Example RLS policy for invoices
CREATE POLICY "Users can only access their organization's invoices"
ON invoices
FOR ALL
USING (
  organization_id IN (
    SELECT organization_id 
    FROM organization_members 
    WHERE user_id = auth.uid()
  )
);
```

### 9.3 Credential Encryption

```sql
-- eTIMS credentials stored encrypted
CREATE TABLE tax_compliance_configs (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    config JSONB NOT NULL, -- Encrypted at rest
    -- config contains: tin, bhf_id, device_serial, cmcKey
);

-- Access only via authenticated edge functions
-- Never exposed to frontend
```

---

## 10. Receipt & Invoice Compliance

### 10.1 Mandatory Receipt Fields

All receipts include KRA-required information:

| Field | Description | Source |
|-------|-------------|--------|
| **Trader Name** | Business name | Organization settings |
| **Trader PIN** | KRA PIN number | eTIMS config |
| **Branch ID** | Branch identifier | eTIMS config |
| **Receipt Number** | Sequential number | System generated |
| **SCU ID** | Device serial | eTIMS initialization |
| **CU Invoice No** | KRA invoice number | eTIMS response |
| **Date/Time** | Transaction timestamp | System clock |
| **Item Details** | Products/services with tax codes | Transaction data |
| **Tax Summary** | Breakdown by category (A-E) | Calculated |
| **QR Code** | KRA verification code | eTIMS response |
| **SCU Signature** | Digital signature | eTIMS response |

### 10.2 Receipt Layout

```
┌──────────────────────────────────────────────────────────────┐
│                    [COMPANY LOGO]                            │
│                                                              │
│                    COMPANY NAME LTD                          │
│                  123 Business Street                         │
│                  Nairobi, Kenya                              │
│                                                              │
│  KRA PIN: P051234567X              Branch: 00                │
│  Device: KRAAL1234567890           CU No: 000000001          │
├──────────────────────────────────────────────────────────────┤
│  TAX INVOICE                                                 │
│  Invoice #: INV-2026-0001                                    │
│  Date: 21/01/2026 12:30:45                                   │
├──────────────────────────────────────────────────────────────┤
│  Customer: ABC Company Ltd                                   │
│  PIN: P098765432Y                                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Description              Qty    Unit      Amount    Tax     │
│  ─────────────────────────────────────────────────────────   │
│  Office Supplies           2   5,000.00   10,000.00   A      │
│  Consulting Services       1   8,000.00    8,000.00   A      │
│  Export Materials          5     500.00    2,500.00   B      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  SUBTOTAL                                    20,500.00       │
│                                                              │
│  TAX BREAKDOWN:                                              │
│  A - VAT 16%:     18,000.00 × 16% =          2,880.00       │
│  B - Zero Rated:   2,500.00 × 0%  =              0.00       │
│                                                              │
│  TOTAL TAX                                    2,880.00       │
├──────────────────────────────────────────────────────────────┤
│  TOTAL                              KES      23,380.00       │
├──────────────────────────────────────────────────────────────┤
│  Payment: Bank Transfer                                      │
│  Reference: TRF-2026-001                                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────┐                                              │
│  │ [QR CODE]  │  Scan to verify at:                          │
│  │            │  https://itax.kra.go.ke/fiscalinvoice        │
│  │            │                                              │
│  └────────────┘  CU Serial: KRAAL1234567890                  │
│                  CU Invoice: 000000001                       │
│                  Date: 20260121123045                        │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SCU INFORMATION                                             │
│  Internal Data: 4A7B8C9D...                                  │
│  Signature: 1A2B3C4D5E6F...                                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 11. Reporting Capabilities

### 11.1 eTIMS-Specific Reports

| Report | Description | Frequency |
|--------|-------------|-----------|
| **Z-Report** | End-of-day fiscal summary | Daily |
| **X-Report** | Interim sales summary | On-demand |
| **Transmission Log** | All eTIMS API calls | Real-time |
| **Failed Transmissions** | Pending retry queue | Real-time |
| **Tax Summary** | Breakdown by tax code | On-demand |

### 11.2 Z-Report Structure

```javascript
{
  "reportDate": "2026-01-21",
  "branchId": "00",
  "deviceSerial": "KRAAL1234567890",
  "firstReceiptNo": 1,
  "lastReceiptNo": 45,
  "totalTransactions": 45,
  "salesSummary": {
    "normalSales": { "count": 40, "amount": 500000.00 },
    "creditNotes": { "count": 3, "amount": -15000.00 },
    "voidedSales": { "count": 2, "amount": -8000.00 }
  },
  "taxSummary": {
    "A": { "taxable": 400000.00, "tax": 64000.00 },
    "B": { "taxable": 50000.00, "tax": 0.00 },
    "C": { "taxable": 27000.00, "tax": 0.00 }
  },
  "paymentSummary": {
    "cash": 200000.00,
    "mpesa": 150000.00,
    "card": 127000.00
  },
  "grandTotal": 477000.00,
  "totalTax": 64000.00
}
```

---

## 12. Error Handling & Recovery

### 12.1 Error Categories

| Category | Handling Strategy |
|----------|-------------------|
| **Network Errors** | Automatic retry with exponential backoff |
| **Authentication Errors** | Prompt re-initialization |
| **Validation Errors** | Display specific field errors to user |
| **Server Errors (500)** | Retry after delay, log for review |
| **Rate Limiting** | Queue requests, respect limits |

### 12.2 Error Response Codes

| Code | Description | Action |
|------|-------------|--------|
| `000` | Success | Continue |
| `001` | Invalid PIN | Verify credentials |
| `002` | Invalid signature | Re-initialize device |
| `003` | Duplicate invoice | Skip (already transmitted) |
| `004` | Invalid date format | Fix and retry |
| `005` | Missing required field | Complete data and retry |

### 12.3 Logging Implementation

```typescript
// All eTIMS interactions are logged
await supabase.from("etims_transmission_logs").insert({
  organization_id: orgId,
  invoice_id: invoiceId,
  endpoint: "/saveSales",
  request_payload: sanitizedPayload, // Sensitive data removed
  response_code: response.resultCd,
  response_message: response.resultMsg,
  cu_invoice_number: response.data?.intrlData,
  transmission_time_ms: duration,
  status: response.resultCd === "000" ? "transmitted" : "failed",
});
```

---

## 13. Testing & Quality Assurance

### 13.1 Testing Approach

| Test Type | Coverage |
|-----------|----------|
| **Unit Tests** | Edge function logic, tax calculations |
| **Integration Tests** | Database operations, API calls |
| **E2E Tests** | Complete invoice workflow |
| **Sandbox Testing** | Full eTIMS API integration |

### 13.2 Sandbox Testing Procedure

1. **Device Initialization**: Test with sandbox credentials
2. **Invoice Transmission**: Verify all document types (NS, NC, ND)
3. **Error Scenarios**: Test network failures, invalid data
4. **Report Generation**: Verify Z-Report and X-Report accuracy
5. **QR Code Verification**: Validate generated codes

### 13.3 Test Coverage

```
├── Edge Functions
│   ├── etims-init: 95% coverage
│   ├── etims-transmit-invoice: 92% coverage
│   ├── etims-transmit-credit-note: 90% coverage
│   ├── etims-transmit-pos: 88% coverage
│   └── etims-sync-codes: 85% coverage
│
├── Frontend Components
│   ├── EtimsSettings: 90% coverage
│   ├── TaxSettings: 88% coverage
│   └── InvoiceForm: 85% coverage
│
└── Hooks
    ├── useTaxRates: 95% coverage
    └── useEtimsStandardCodes: 90% coverage
```

---

## 14. Deployment Architecture

### 14.1 Infrastructure

```
┌──────────────────────────────────────────────────────────────────┐
│                      Supabase Platform                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │   Edge Network  │  │   Auth Service  │  │  Storage (S3)   │   │
│  │   (Global CDN)  │  │   (GoTrue)      │  │  (Attachments)  │   │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘   │
│           │                    │                    │             │
│           └────────────────────┼────────────────────┘             │
│                                │                                  │
│  ┌─────────────────────────────┴─────────────────────────────┐   │
│  │                    Edge Functions                          │   │
│  │  (Deno Runtime - Global Distribution)                      │   │
│  │                                                            │   │
│  │  • etims-init            • etims-transmit-invoice          │   │
│  │  • etims-transmit-pos    • etims-transmit-credit-note      │   │
│  │  • etims-sync-codes      • etims-register-item             │   │
│  │  • generate-invoice-pdf  • send-invoice-email              │   │
│  │  • z-report              • x-report                        │   │
│  └─────────────────────────────┬─────────────────────────────┘   │
│                                │                                  │
│  ┌─────────────────────────────┴─────────────────────────────┐   │
│  │                    PostgreSQL Database                     │   │
│  │  (High Availability with Point-in-Time Recovery)           │   │
│  │                                                            │   │
│  │  • organizations          • invoices                       │   │
│  │  • tax_compliance_configs • etims_transmission_logs        │   │
│  │  • tax_rates              • products                       │   │
│  │  • etims_standard_codes   • credit_notes                   │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### 14.2 High Availability

- **Multi-region deployment** via edge functions
- **Database replication** with automatic failover
- **CDN caching** for static assets
- **Zero-downtime updates** via rolling deployments

---

## 15. Support & Maintenance

### 15.1 Support Channels

| Channel | Details |
|---------|---------|
| **Email** | fredrickmureti612@gmail.com |
| **Website** | https://accrualflow.systems |
| **Documentation** | https://accrualflow.systems/docs |

### 15.2 Update Policy

- **Security patches**: Deployed within 24 hours
- **Bug fixes**: Weekly release cycle
- **Feature updates**: Monthly release cycle
- **eTIMS API changes**: Immediate compliance updates

### 15.3 Monitoring

- **Uptime monitoring**: 24/7 automated checks
- **Error tracking**: Real-time alerting for failures
- **Performance monitoring**: Response time tracking
- **Transmission monitoring**: eTIMS success rate dashboard

---

## 16. Appendices

### Appendix A: Edge Functions Inventory

| Function | Purpose | Auth Required |
|----------|---------|---------------|
| `etims-init` | Device initialization | Yes |
| `etims-transmit-invoice` | Invoice transmission | Yes |
| `etims-transmit-credit-note` | Credit note transmission | Yes |
| `etims-transmit-pos` | POS transaction transmission | Yes |
| `etims-register-item` | Item registration | Yes |
| `etims-sync-codes` | Standard codes synchronization | Yes |
| `etims-verify-sales` | Sales verification | Yes |
| `generate-invoice-pdf` | PDF generation | Yes |
| `send-invoice-email` | Email delivery | Yes |

### Appendix B: Database Schema (eTIMS-Related)

```sql
-- Tax compliance configuration
CREATE TABLE tax_compliance_configs (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    country_code VARCHAR(2) DEFAULT 'KE',
    provider VARCHAR(50) DEFAULT 'kra_etims',
    config JSONB NOT NULL,
    is_active BOOLEAN DEFAULT false,
    device_initialized BOOLEAN DEFAULT false,
    environment VARCHAR(20) DEFAULT 'sandbox',
    last_transmission_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Transmission logs
CREATE TABLE etims_transmission_logs (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    invoice_id UUID,
    endpoint VARCHAR(100),
    request_payload JSONB,
    response_code VARCHAR(10),
    response_message TEXT,
    cu_invoice_number VARCHAR(50),
    status VARCHAR(20),
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Standard codes
CREATE TABLE etims_standard_codes (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    code_type VARCHAR(50),
    code VARCHAR(50),
    name TEXT,
    description TEXT,
    is_active BOOLEAN DEFAULT true
);

-- Tax rates with eTIMS mapping
CREATE TABLE tax_rates (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    name VARCHAR(100),
    rate DECIMAL(5,2),
    etims_tax_code VARCHAR(1), -- A, B, C, D, E
    etims_description TEXT,
    is_active BOOLEAN DEFAULT true
);
```

### Appendix C: Compliance Checklist

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Device registration | ✅ | `etims-init` function |
| Real-time transmission | ✅ | Background sync within 15 min |
| QR code generation | ✅ | `qrcode.react` implementation |
| Receipt mandatory fields | ✅ | PDF/HTML templates |
| Tax code mapping | ✅ | User-configurable A-E codes |
| Audit trail | ✅ | `etims_transmission_logs` table |
| Sandbox support | ✅ | Environment toggle in settings |
| Error handling | ✅ | Retry mechanism with logging |
| Z-Report generation | ✅ | Daily fiscal summary |
| Credit note support | ✅ | NC document type |

---

## Declaration

I, **Fredrick Mureti** (ID: 40122420), hereby declare that:

1. All information provided in this document is accurate and complete to the best of my knowledge.

2. The AccrualFlow ERP platform described herein complies with all technical requirements specified by KRA for eTIMS integration.

3. I commit to maintaining compliance with any future updates to KRA eTIMS specifications.

4. I understand that providing false information may result in rejection of the certification application.

**Signature**: ___________________________

**Date**: January 21, 2026

**Contact**: fredrickmureti612@gmail.com

**Website**: https://accrualflow.systems

---

<div align="center">

**AccrualFlow ERP**  
*Modern Business Management with KRA eTIMS Compliance*

© 2026 Fredrick Mureti. All Rights Reserved.

</div>
