# Inventory Test Data

## Warehouses (3)

### Warehouse 1 - Main
| Field | Value |
|-------|-------|
| **Name** | Nairobi Main Warehouse |
| **Code** | WH-NBO-MAIN |
| **Type** | Main |
| **Address** | Industrial Area, Enterprise Road |
| **City** | Nairobi |
| **Manager** | John Kamau |
| **Phone** | +254 722 100 001 |
| **Is Active** | Yes |

### Warehouse 2 - Retail
| Field | Value |
|-------|-------|
| **Name** | Westlands Showroom |
| **Code** | WH-NBO-WEST |
| **Type** | Retail |
| **Address** | Sarit Centre, Shop G-15 |
| **City** | Nairobi |
| **Manager** | Mary Wanjiru |
| **Phone** | +254 722 100 002 |
| **Is Active** | Yes |

### Warehouse 3 - Branch
| Field | Value |
|-------|-------|
| **Name** | Mombasa Branch |
| **Code** | WH-MSA-001 |
| **Type** | Branch |
| **Address** | Moi Avenue, Mombasa |
| **City** | Mombasa |
| **Manager** | Ahmed Hassan |
| **Phone** | +254 722 100 003 |
| **Is Active** | Yes |

---

## Storage Locations (Per Warehouse)

### Nairobi Main Warehouse
| Location Code | Name | Zone | Bin Type |
|---------------|------|------|----------|
| NBO-A-01 | Aisle A - Shelf 1 | Receiving | Shelf |
| NBO-A-02 | Aisle A - Shelf 2 | Receiving | Shelf |
| NBO-B-01 | Aisle B - Shelf 1 | Electronics | Shelf |
| NBO-B-02 | Aisle B - Shelf 2 | Electronics | Shelf |
| NBO-B-03 | Aisle B - Shelf 3 | Electronics | Shelf |
| NBO-C-01 | Aisle C - Pallet 1 | Bulk Storage | Pallet |
| NBO-C-02 | Aisle C - Pallet 2 | Bulk Storage | Pallet |
| NBO-PACK-01 | Packing Area 1 | Shipping | Floor |
| NBO-SHIP-01 | Shipping Dock 1 | Shipping | Dock |

### Westlands Showroom
| Location Code | Name | Zone | Bin Type |
|---------------|------|------|----------|
| WST-SHOW-01 | Display Area 1 | Showroom | Display |
| WST-SHOW-02 | Display Area 2 | Showroom | Display |
| WST-BACK-01 | Back Storage | Storage | Shelf |

---

## Current Stock Levels

### Nairobi Main Warehouse
| Product | SKU | Qty | Location | Min Stock | Max Stock |
|---------|-----|-----|----------|-----------|-----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 15 | NBO-B-01 | 5 | 30 |
| HP LaserJet Pro M404n | HP-LJ-M404N | 8 | NBO-B-02 | 3 | 20 |
| Samsung 27" Monitor | SAM-MON-27 | 28 | NBO-B-02 | 10 | 50 |
| Logitech Keyboard & Mouse | LOG-KB-MOU-W | 65 | NBO-A-01 | 20 | 100 |
| Cat6 Ethernet Cable 5M | CAT6-5M | 145 | NBO-C-01 | 50 | 300 |
| iPhone 15 Pro 256GB | APPL-IP15P-256 | 12 | NBO-B-03 | 5 | 25 |
| External SSD 1TB Samsung | SAM-SSD-1TB | 32 | NBO-B-01 | 15 | 60 |
| Cisco 24-Port Switch | CISCO-SW-24 | 4 | NBO-B-03 | 3 | 15 |
| Webcam HD 1080p | WEB-HD-1080 | 42 | NBO-A-02 | 20 | 80 |
| UPS 1500VA APC | APC-UPS-1500 | 11 | NBO-C-02 | 5 | 25 |

### Westlands Showroom
| Product | SKU | Qty | Location |
|---------|-----|-----|----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 3 | WST-SHOW-01 |
| Samsung 27" Monitor | SAM-MON-27 | 5 | WST-SHOW-01 |
| iPhone 15 Pro 256GB | APPL-IP15P-256 | 4 | WST-SHOW-02 |
| Logitech Keyboard & Mouse | LOG-KB-MOU-W | 10 | WST-BACK-01 |

### Mombasa Branch
| Product | SKU | Qty | Location |
|---------|-----|-----|----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 5 | MSA-MAIN |
| HP LaserJet Pro M404n | HP-LJ-M404N | 4 | MSA-MAIN |
| Samsung 27" Monitor | SAM-MON-27 | 8 | MSA-MAIN |
| UPS 1500VA APC | APC-UPS-1500 | 6 | MSA-MAIN |

---

## Stock Movements

### Stock Transfer 1
| Field | Value |
|-------|-------|
| **Transfer Number** | TRF-2024-0001 |
| **Date** | 2024-01-20 |
| **From** | Nairobi Main Warehouse |
| **To** | Westlands Showroom |
| **Status** | Completed |

| Product | SKU | Quantity |
|---------|-----|----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 3 |
| Samsung 27" Monitor | SAM-MON-27 | 5 |
| iPhone 15 Pro 256GB | APPL-IP15P-256 | 4 |

---

### Stock Transfer 2
| Field | Value |
|-------|-------|
| **Transfer Number** | TRF-2024-0002 |
| **Date** | 2024-02-01 |
| **From** | Nairobi Main Warehouse |
| **To** | Mombasa Branch |
| **Status** | Completed |

| Product | SKU | Quantity |
|---------|-----|----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 5 |
| HP LaserJet Pro M404n | HP-LJ-M404N | 4 |
| Samsung 27" Monitor | SAM-MON-27 | 8 |
| UPS 1500VA APC | APC-UPS-1500 | 6 |

---

### Goods Receipt 1
| Field | Value |
|-------|-------|
| **Receipt Number** | GRN-2024-0001 |
| **Date** | 2024-01-12 |
| **Vendor** | Samsung Kenya Ltd |
| **PO Reference** | PO-2024-0001 |
| **Warehouse** | Nairobi Main Warehouse |
| **Status** | Received |

| Product | SKU | Ordered | Received | Location |
|---------|-----|---------|----------|----------|
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 15 | 15 | NBO-B-01 |
| Samsung 27" Monitor | SAM-MON-27 | 20 | 20 | NBO-B-02 |

---

### Stock Adjustment 1
| Field | Value |
|-------|-------|
| **Adjustment Number** | ADJ-2024-0001 |
| **Date** | 2024-01-31 |
| **Warehouse** | Nairobi Main Warehouse |
| **Reason** | Physical Count Variance |
| **Approved By** | John Kamau |

| Product | SKU | System Qty | Physical Qty | Adjustment |
|---------|-----|------------|--------------|------------|
| Cat6 Ethernet Cable 5M | CAT6-5M | 150 | 145 | -5 |
| Logitech Keyboard & Mouse | LOG-KB-MOU-W | 68 | 65 | -3 |

---

## Reorder Alerts

| Product | SKU | Current Stock | Reorder Level | Suggested Qty |
|---------|-----|---------------|---------------|---------------|
| Cisco 24-Port Switch | CISCO-SW-24 | 4 | 3 | 5 |
| HP LaserJet Pro M404n | HP-LJ-M404N | 8 | 3 | 5 |
| Dell Laptop Latitude 5520 | DELL-LAT-5520 | 15 | 5 | 10 |

---

## Inventory Valuation Summary

| Category | Items | Total Units | Avg Cost | Total Value |
|----------|-------|-------------|----------|-------------|
| Computers | 3 | 35 | 85,000 | 2,975,000 |
| Monitors | 1 | 41 | 18,500 | 758,500 |
| Printers | 1 | 12 | 28,000 | 336,000 |
| Mobile Phones | 1 | 16 | 145,000 | 2,320,000 |
| Accessories | 2 | 117 | 3,700 | 433,100 |
| Networking | 2 | 149 | 17,725 | 2,641,225 |
| Storage | 1 | 32 | 8,500 | 272,000 |
| Power | 1 | 17 | 22,000 | 374,000 |
| **Total** | **12** | **419** | | **10,109,825** |
