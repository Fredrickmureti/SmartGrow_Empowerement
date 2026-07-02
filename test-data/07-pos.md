# Point of Sale (POS) Test Data

## Registers (3)

### Register 1
| Field | Value |
|-------|-------|
| **Name** | Register 1 - Main Counter |
| **Code** | REG-001 |
| **Location** | Westlands Showroom |
| **Status** | Active |
| **Default Payment Methods** | Cash, M-PESA, Card |

### Register 2
| Field | Value |
|-------|-------|
| **Name** | Register 2 - Electronics |
| **Code** | REG-002 |
| **Location** | Westlands Showroom |
| **Status** | Active |
| **Default Payment Methods** | Cash, M-PESA, Card |

### Register 3
| Field | Value |
|-------|-------|
| **Name** | Register 1 - Mombasa |
| **Code** | REG-MSA-001 |
| **Location** | Mombasa Branch |
| **Status** | Active |
| **Default Payment Methods** | Cash, M-PESA |

---

## Shifts

### Shift 1 - Morning Shift
| Field | Value |
|-------|-------|
| **Shift Number** | SHIFT-2024-0001 |
| **Register** | REG-001 |
| **Cashier** | Mary Wanjiru |
| **Opened At** | 2024-02-10 08:00:00 |
| **Closed At** | 2024-02-10 14:00:00 |
| **Opening Cash** | 10,000 |
| **Expected Cash** | 125,500 |
| **Actual Cash** | 125,500 |
| **Difference** | 0 |
| **Status** | Reconciled |

### Shift 2 - Afternoon Shift
| Field | Value |
|-------|-------|
| **Shift Number** | SHIFT-2024-0002 |
| **Register** | REG-001 |
| **Cashier** | Peter Otieno |
| **Opened At** | 2024-02-10 14:00:00 |
| **Closed At** | 2024-02-10 20:00:00 |
| **Opening Cash** | 10,000 |
| **Expected Cash** | 98,750 |
| **Actual Cash** | 98,600 |
| **Difference** | -150 |
| **Status** | Reconciled |
| **Notes** | Minor shortage - coins |

### Shift 3 - Current Open Shift
| Field | Value |
|-------|-------|
| **Shift Number** | SHIFT-2024-0003 |
| **Register** | REG-001 |
| **Cashier** | Mary Wanjiru |
| **Opened At** | 2024-02-11 08:00:00 |
| **Closed At** | - |
| **Opening Cash** | 10,000 |
| **Status** | Open |

---

## POS Transactions

### Transaction 1 - Cash Sale
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0001 |
| **Shift** | SHIFT-2024-0001 |
| **Date/Time** | 2024-02-10 09:15:32 |
| **Cashier** | Mary Wanjiru |
| **Customer** | Walk-in |
| **Type** | Sale |

**Items:**
| Product | Qty | Unit Price | Tax | Total |
|---------|-----|------------|-----|-------|
| Logitech Keyboard & Mouse | 2 | 4,800 | 1,536 | 11,136 |
| Cat6 Ethernet Cable 5M | 5 | 750 | 600 | 4,350 |

| **Subtotal** | 13,350 |
| **VAT (16%)** | 2,136 |
| **Total** | 15,486 |

**Payment:**
| Method | Amount |
|--------|--------|
| Cash | 16,000 |
| Change | 514 |

---

### Transaction 2 - Card Sale
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0002 |
| **Shift** | SHIFT-2024-0001 |
| **Date/Time** | 2024-02-10 10:45:18 |
| **Cashier** | Mary Wanjiru |
| **Customer** | Grace Wanjiku |
| **Type** | Sale |

**Items:**
| Product | Qty | Unit Price | Tax | Total |
|---------|-----|------------|-----|-------|
| Samsung 27" Monitor | 1 | 28,000 | 4,480 | 32,480 |
| Webcam HD 1080p | 1 | 6,500 | 1,040 | 7,540 |

| **Subtotal** | 34,500 |
| **VAT (16%)** | 5,520 |
| **Total** | 40,020 |

**Payment:**
| Method | Amount | Reference |
|--------|--------|-----------|
| Card (Visa) | 40,020 | AUTH-4521 |

---

### Transaction 3 - M-PESA Sale
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0003 |
| **Shift** | SHIFT-2024-0001 |
| **Date/Time** | 2024-02-10 11:22:05 |
| **Cashier** | Mary Wanjiru |
| **Customer** | Walk-in |
| **Type** | Sale |

**Items:**
| Product | Qty | Unit Price | Tax | Total |
|---------|-----|------------|-----|-------|
| External SSD 1TB Samsung | 1 | 12,500 | 2,000 | 14,500 |

| **Subtotal** | 12,500 |
| **VAT (16%)** | 2,000 |
| **Total** | 14,500 |

**Payment:**
| Method | Amount | Reference |
|--------|--------|-----------|
| M-PESA | 14,500 | RAK4M7N2XP |

---

### Transaction 4 - Split Payment
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0004 |
| **Shift** | SHIFT-2024-0001 |
| **Date/Time** | 2024-02-10 12:08:44 |
| **Cashier** | Mary Wanjiru |
| **Customer** | James Ochieng |
| **Type** | Sale |

**Items:**
| Product | Qty | Unit Price | Tax | Total |
|---------|-----|------------|-----|-------|
| Dell Laptop Latitude 5520 | 1 | 125,000 | 20,000 | 145,000 |

| **Subtotal** | 125,000 |
| **VAT (16%)** | 20,000 |
| **Total** | 145,000 |

**Payment:**
| Method | Amount | Reference |
|--------|--------|-----------|
| M-PESA | 100,000 | RBK5L8M3YQ |
| Card (Visa) | 45,000 | AUTH-4522 |

---

### Transaction 5 - Return/Refund
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0005 |
| **Shift** | SHIFT-2024-0002 |
| **Date/Time** | 2024-02-10 15:30:12 |
| **Cashier** | Peter Otieno |
| **Customer** | Walk-in |
| **Type** | Return |
| **Original Transaction** | POS-2024-0003 |
| **Return Reason** | Defective |

**Items:**
| Product | Qty | Unit Price | Tax | Total |
|---------|-----|------------|-----|-------|
| External SSD 1TB Samsung | -1 | 12,500 | 2,000 | -14,500 |

| **Refund Total** | -14,500 |

**Refund:**
| Method | Amount |
|--------|--------|
| Cash | -14,500 |

---

### Transaction 6 - With Discount
| Field | Value |
|-------|-------|
| **Transaction #** | POS-2024-0006 |
| **Shift** | SHIFT-2024-0002 |
| **Date/Time** | 2024-02-10 16:45:30 |
| **Cashier** | Peter Otieno |
| **Customer** | Walk-in |
| **Type** | Sale |
| **Discount** | 10% Staff Discount |

**Items:**
| Product | Qty | Unit Price | Discount | Tax | Total |
|---------|-----|------------|----------|-----|-------|
| iPhone 15 Pro 256GB | 1 | 189,000 | 18,900 | 27,216 | 197,316 |

| **Subtotal** | 189,000 |
| **Discount (10%)** | -18,900 |
| **Net** | 170,100 |
| **VAT (16%)** | 27,216 |
| **Total** | 197,316 |

**Payment:**
| Method | Amount | Reference |
|--------|--------|-----------|
| Card (Mastercard) | 197,316 | AUTH-4523 |

---

## Daily Summary - 2024-02-10

### By Payment Method
| Method | Count | Amount |
|--------|-------|--------|
| Cash | 2 | 986 |
| M-PESA | 2 | 114,500 |
| Card | 3 | 282,336 |
| **Total** | **7** | **397,822** |

### By Hour
| Hour | Transactions | Amount |
|------|--------------|--------|
| 09:00 | 1 | 15,486 |
| 10:00 | 1 | 40,020 |
| 11:00 | 1 | 14,500 |
| 12:00 | 1 | 145,000 |
| 15:00 | 1 | -14,500 |
| 16:00 | 1 | 197,316 |

### Top Selling Products
| Product | Units Sold | Revenue |
|---------|------------|---------|
| Dell Laptop Latitude 5520 | 1 | 145,000 |
| iPhone 15 Pro 256GB | 1 | 170,100 |
| Samsung 27" Monitor | 1 | 32,480 |

---

## Payment Methods

| Method | Code | Is Active | Settings |
|--------|------|-----------|----------|
| Cash | CASH | Yes | - |
| M-PESA | MPESA | Yes | Till: 174379, Paybill: 174379 |
| Visa | VISA | Yes | Terminal: POS-001 |
| Mastercard | MCARD | Yes | Terminal: POS-001 |
| Bank Transfer | BANK | Yes | Account: Equity 1234567890 |

---

## Quick Products (Favorites)

| Position | Product | Price |
|----------|---------|-------|
| 1 | Cat6 Ethernet Cable 5M | 750 |
| 2 | Logitech Keyboard & Mouse | 4,800 |
| 3 | Webcam HD 1080p | 6,500 |
| 4 | External SSD 1TB Samsung | 12,500 |
| 5 | Samsung 27" Monitor | 28,000 |
| 6 | HP LaserJet Pro M404n | 42,000 |
