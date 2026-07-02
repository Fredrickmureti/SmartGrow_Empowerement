# Banking & Reconciliation Test Data

## Bank Accounts (3)

### Account 1 - Main Operating Account
| Field | Value |
|-------|-------|
| **Name** | Equity Bank - Main Operating |
| **Bank** | Equity Bank |
| **Account Number** | 0640261234567 |
| **Branch** | Upper Hill |
| **Currency** | KES |
| **Opening Balance** | 2,500,000 |
| **Current Balance** | 3,245,680 |
| **Is Primary** | Yes |
| **Last Sync** | 2024-02-10 |

### Account 2 - Secondary Account
| Field | Value |
|-------|-------|
| **Name** | KCB - Savings |
| **Bank** | KCB Bank |
| **Account Number** | 1234567890123 |
| **Branch** | Westlands |
| **Currency** | KES |
| **Opening Balance** | 1,800,000 |
| **Current Balance** | 1,650,000 |
| **Is Primary** | No |
| **Last Sync** | 2024-02-08 |

### Account 3 - M-PESA Business
| Field | Value |
|-------|-------|
| **Name** | M-PESA Business Till |
| **Provider** | Safaricom |
| **Till Number** | 174379 |
| **Currency** | KES |
| **Opening Balance** | 350,000 |
| **Current Balance** | 485,230 |
| **Is Primary** | No |
| **Auto Sweep** | Yes (daily to Equity) |

---

## Bank Transactions - Equity Bank (February 2024)

### Credits (Money In)
| Date | Reference | Description | Amount | Balance |
|------|-----------|-------------|--------|---------|
| 2024-02-01 | TRF-001 | Safaricom PLC - Invoice Payment | 1,830,480 | 4,330,480 |
| 2024-02-05 | TRF-002 | Equity Bank Ltd - Partial Payment | 300,000 | 4,630,480 |
| 2024-02-08 | CHQ-DEP | Cheque Deposit - Various | 250,000 | 4,880,480 |
| 2024-02-10 | MPESA-SWP | M-PESA Daily Sweep | 125,500 | 5,005,980 |
| 2024-02-12 | TRF-003 | Grace Wanjiku - Invoice Payment | 45,588 | 5,051,568 |

### Debits (Money Out)
| Date | Reference | Description | Amount | Balance |
|------|-----------|-------------|--------|---------|
| 2024-02-02 | EFT-001 | Samsung Kenya - Supplier Payment | -1,908,200 | 2,422,280 |
| 2024-02-05 | EFT-002 | January Rent - Westlands | -174,000 | 2,248,280 |
| 2024-02-08 | EFT-003 | KPLC - Electricity | -45,000 | 2,203,280 |
| 2024-02-10 | RTGS-001 | Furniture Palace - Partial | -250,000 | 1,953,280 |
| 2024-02-11 | CHQ-001 | Office Mart - Stationery | -156,600 | 1,796,680 |
| 2024-02-12 | FEES | Bank Charges - February | -3,500 | 1,793,180 |

---

## Bank Transactions - M-PESA (February 2024)

| Date | Reference | Description | Type | Amount | Balance |
|------|-----------|-------------|------|--------|---------|
| 2024-02-01 | RAK4M7N2XP | Customer Payment - POS | Credit | 14,500 | 364,500 |
| 2024-02-01 | RBK5L8M3YQ | Customer Payment - Invoice | Credit | 100,000 | 464,500 |
| 2024-02-02 | SWEEP-001 | Daily Sweep to Equity | Debit | -50,000 | 414,500 |
| 2024-02-03 | RCL6N9O4ZR | Customer Payment - POS | Credit | 8,500 | 423,000 |
| 2024-02-04 | RDM7O0P5AS | Customer Payment - POS | Credit | 12,350 | 435,350 |
| 2024-02-05 | SWEEP-002 | Daily Sweep to Equity | Debit | -20,850 | 414,500 |
| 2024-02-06 | REN8P1Q6BT | Customer Payment - Walk-in | Credit | 45,000 | 459,500 |
| 2024-02-07 | RFO9Q2R7CU | Customer Payment - POS | Credit | 22,800 | 482,300 |
| 2024-02-08 | SWEEP-003 | Daily Sweep to Equity | Debit | -67,800 | 414,500 |
| 2024-02-09 | RGP0R3S8DV | Customer Payment - Invoice | Credit | 55,000 | 469,500 |
| 2024-02-10 | RHQ1S4T9EW | Customer Payment - POS | Credit | 15,730 | 485,230 |

---

## Reconciliation Status

### Equity Bank - February 2024
| Status | Transactions | Amount |
|--------|--------------|--------|
| Reconciled | 8 | 4,154,568 |
| Unreconciled | 3 | 651,912 |
| Pending Review | 1 | 3,500 |

### Unreconciled Transactions
| Date | Reference | Description | Amount | Suggested Match |
|------|-----------|-------------|--------|-----------------|
| 2024-02-08 | CHQ-DEP | Cheque Deposit - Various | 250,000 | No match |
| 2024-02-10 | MPESA-SWP | M-PESA Daily Sweep | 125,500 | M-PESA SWEEP-003 |
| 2024-02-12 | TRF-003 | Grace Wanjiku | 45,588 | INV-2024-0007 |

---

## Bank Rules (Auto-Categorization)

| Rule Name | Condition | Category | Account |
|-----------|-----------|----------|---------|
| KPLC Payments | Description contains "KPLC" | Utilities | 5610 |
| Rent Payments | Description contains "Rent" | Rent Expense | 5600 |
| Bank Charges | Description contains "Charges" or "Fees" | Bank Charges | 5910 |
| M-PESA Sweep | Reference starts with "SWEEP" | Internal Transfer | - |
| Salary Payments | Description contains "Salary" or "Payroll" | Salaries | 5500 |
| Supplier Payment | Description contains "Supplier" | Accounts Payable | 2000 |

---

## Petty Cash

### Petty Cash Account
| Field | Value |
|-------|-------|
| **Name** | Petty Cash - Nairobi |
| **Custodian** | Grace Njeri |
| **Float Amount** | 25,000 |
| **Current Balance** | 12,350 |
| **Last Replenishment** | 2024-02-01 |

### Petty Cash Transactions - February 2024
| Date | Description | Category | Amount | Balance |
|------|-------------|----------|--------|---------|
| 2024-02-01 | Opening Balance | - | - | 25,000 |
| 2024-02-02 | Office Tea/Coffee | Office Supplies | -1,500 | 23,500 |
| 2024-02-03 | Taxi - Client Meeting | Travel | -2,000 | 21,500 |
| 2024-02-05 | Stationery | Office Supplies | -3,200 | 18,300 |
| 2024-02-06 | Courier - DHL | Postage | -850 | 17,450 |
| 2024-02-07 | Staff Lunch - Team Meeting | Entertainment | -4,500 | 12,950 |
| 2024-02-08 | Parking - Town | Travel | -600 | 12,350 |

---

## Payment Methods

| Method | Type | Details | Active |
|--------|------|---------|--------|
| Bank Transfer (EFT) | Electronic | Equity Bank API | Yes |
| RTGS | Electronic | For amounts > 1M | Yes |
| Cheque | Manual | Equity Bank Cheques | Yes |
| M-PESA (B2B) | Mobile | Business Till 174379 | Yes |
| M-PESA (B2C) | Mobile | For refunds/payments | Yes |
| Petty Cash | Cash | Office float | Yes |
| Card Payment | Electronic | POS Terminal | Yes |

---

## Scheduled Payments

| Payee | Amount | Frequency | Next Date | Account |
|-------|--------|-----------|-----------|---------|
| Landlord (Rent) | 174,000 | Monthly | 2024-03-05 | Equity |
| KPLC (Electricity) | ~45,000 | Monthly | 2024-03-08 | Equity |
| Safaricom (Internet) | 25,000 | Monthly | 2024-03-15 | Equity |
| G4S Security | 168,200 | Monthly | 2024-03-02 | Equity |
| KRA (PAYE) | 458,750 | Monthly | 2024-03-09 | Equity |
| KRA (VAT) | ~180,000 | Monthly | 2024-03-20 | Equity |
