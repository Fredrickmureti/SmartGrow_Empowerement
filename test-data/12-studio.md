# Studio (Customization) Test Data

## Custom Fields

### Custom Fields - Contacts
| Field Name | Label | Type | Required | Options/Default |
|------------|-------|------|----------|-----------------|
| customer_segment | Customer Segment | Select | No | SME, Corporate, Government, Individual |
| loyalty_points | Loyalty Points | Number | No | Default: 0 |
| preferred_contact_method | Preferred Contact | Select | No | Email, Phone, WhatsApp |
| account_manager | Account Manager | Text | No | - |
| last_purchase_date | Last Purchase | Date | No | - |
| customer_since | Customer Since | Date | No | - |
| notes_internal | Internal Notes | Text Area | No | - |

### Custom Fields - Products
| Field Name | Label | Type | Required | Options/Default |
|------------|-------|------|----------|-----------------|
| warranty_months | Warranty (Months) | Number | No | Default: 12 |
| brand | Brand | Text | No | - |
| model_number | Model Number | Text | No | - |
| weight_kg | Weight (KG) | Number | No | - |
| dimensions | Dimensions (LxWxH) | Text | No | - |
| country_of_origin | Country of Origin | Select | No | Kenya, China, USA, Germany, Japan |
| is_featured | Featured Product | Boolean | No | Default: false |
| promotion_tag | Promotion Tag | Text | No | - |

### Custom Fields - Invoices
| Field Name | Label | Type | Required | Options/Default |
|------------|-------|------|----------|-----------------|
| purchase_order_number | Customer PO Number | Text | No | - |
| delivery_date | Delivery Date | Date | No | - |
| delivery_address | Delivery Address | Text Area | No | - |
| salesperson | Salesperson | Text | No | - |
| project_code | Project Code | Text | No | - |
| approved_by | Approved By | Text | No | - |

### Custom Fields - Employees
| Field Name | Label | Type | Required | Options/Default |
|------------|-------|------|----------|-----------------|
| emergency_contact_name | Emergency Contact | Text | Yes | - |
| emergency_contact_phone | Emergency Phone | Text | Yes | - |
| blood_type | Blood Type | Select | No | A+, A-, B+, B-, O+, O-, AB+, AB- |
| medical_conditions | Medical Conditions | Text Area | No | - |
| shirt_size | Uniform Size | Select | No | XS, S, M, L, XL, XXL |
| skills | Skills | Text | No | - |

---

## Automated Actions

### Action 1 - Invoice Reminder
| Field | Value |
|-------|-------|
| **Name** | Overdue Invoice Reminder |
| **Target Model** | invoices |
| **Trigger** | Scheduled (Daily at 9:00 AM) |
| **Condition** | status = 'sent' AND due_date < TODAY() AND due_date >= TODAY() - 7 |
| **Active** | Yes |

**Steps:**
1. Send Email to customer.email
   - Subject: "Payment Reminder: Invoice {invoice_number}"
   - Template: overdue_reminder_template

2. Create Activity
   - Type: Email
   - Note: "Overdue reminder sent automatically"

---

### Action 2 - Low Stock Alert
| Field | Value |
|-------|-------|
| **Name** | Low Stock Alert |
| **Target Model** | products |
| **Trigger** | On Update (stock_quantity changed) |
| **Condition** | stock_quantity <= reorder_level AND is_active = true |
| **Active** | Yes |

**Steps:**
1. Send Email to operations@acmekenya.co.ke
   - Subject: "Low Stock Alert: {name}"
   - Body: "Product {sku} - {name} is low on stock. Current: {stock_quantity}, Reorder Level: {reorder_level}"

2. Create Task
   - Title: "Reorder {name}"
   - Assigned To: Procurement Team
   - Priority: High

---

### Action 3 - New Lead Assignment
| Field | Value |
|-------|-------|
| **Name** | Auto-Assign New Leads |
| **Target Model** | leads |
| **Trigger** | On Create |
| **Condition** | assigned_to IS NULL |
| **Active** | Yes |

**Steps:**
1. Set Field: assigned_to
   - Value: Round-robin from Sales Team

2. Send Email to assigned user
   - Subject: "New Lead Assigned: {company}"
   - Template: new_lead_assigned_template

3. Create Activity
   - Type: Task
   - Title: "Follow up with new lead: {company}"
   - Due: TODAY() + 1

---

### Action 4 - Welcome Email
| Field | Value |
|-------|-------|
| **Name** | Welcome New Customer |
| **Target Model** | contacts |
| **Trigger** | On Create |
| **Condition** | contact_type = 'customer' |
| **Active** | Yes |

**Steps:**
1. Send Email to contact.email
   - Subject: "Welcome to Acme Kenya!"
   - Template: welcome_customer_template

2. Set Field: customer_since
   - Value: TODAY()

---

### Action 5 - Payroll Notification
| Field | Value |
|-------|-------|
| **Name** | Payroll Processing Reminder |
| **Target Model** | - |
| **Trigger** | Scheduled (25th of each month at 9:00 AM) |
| **Active** | Yes |

**Steps:**
1. Send Email to hr@acmekenya.co.ke, finance@acmekenya.co.ke
   - Subject: "Payroll Processing Reminder"
   - Body: "This is a reminder that payroll needs to be processed by the end of the month."

---

### Action 6 - Contract Expiry Alert
| Field | Value |
|-------|-------|
| **Name** | Employee Contract Expiry |
| **Target Model** | employees |
| **Trigger** | Scheduled (Daily at 8:00 AM) |
| **Condition** | employment_type = 'contract' AND contract_end_date = TODAY() + 30 |
| **Active** | Yes |

**Steps:**
1. Send Email to hr@acmekenya.co.ke
   - Subject: "Contract Expiring: {first_name} {last_name}"
   - Body: "Employee contract expires in 30 days. Please review for renewal."

2. Create Task
   - Title: "Review contract: {first_name} {last_name}"
   - Assigned To: HR Manager
   - Due: TODAY() + 14

---

## Email Templates

### Template 1 - Overdue Reminder
| Field | Value |
|-------|-------|
| **Name** | overdue_reminder_template |
| **Subject** | Payment Reminder: Invoice {{invoice_number}} |

**Body:**
```
Dear {{contact.name}},

This is a friendly reminder that invoice {{invoice_number}} dated {{invoice_date}} 
for KES {{total}} is now overdue.

Original Due Date: {{due_date}}
Days Overdue: {{days_overdue}}
Outstanding Amount: KES {{balance}}

Please arrange for payment at your earliest convenience.

Bank Details:
Bank: Equity Bank
Account: 0640261234567
Account Name: Acme Kenya Ltd

If you have already made the payment, please ignore this reminder.

Best regards,
Acme Kenya Ltd
```

---

### Template 2 - Welcome Customer
| Field | Value |
|-------|-------|
| **Name** | welcome_customer_template |
| **Subject** | Welcome to Acme Kenya! |

**Body:**
```
Dear {{name}},

Welcome to Acme Kenya Ltd! We're thrilled to have you as our customer.

As a valued customer, you'll enjoy:
- Competitive pricing on quality products
- Fast delivery across Kenya
- Dedicated customer support
- Exclusive offers and promotions

Your Account Details:
Customer Number: {{customer_number}}
Account Manager: {{account_manager}}

If you have any questions, feel free to reach out:
📞 +254 722 000 000
📧 support@acmekenya.co.ke

We look forward to serving you!

Best regards,
The Acme Kenya Team
```

---

### Template 3 - Invoice
| Field | Value |
|-------|-------|
| **Name** | invoice_email_template |
| **Subject** | Invoice {{invoice_number}} from Acme Kenya Ltd |

**Body:**
```
Dear {{contact.name}},

Please find attached invoice {{invoice_number}} for your recent purchase.

Invoice Details:
Invoice Number: {{invoice_number}}
Invoice Date: {{invoice_date}}
Due Date: {{due_date}}
Total Amount: KES {{total}}

Payment Methods:
1. Bank Transfer - Equity Bank, A/C: 0640261234567
2. M-PESA Paybill: 174379, Account: {{invoice_number}}

Thank you for your business!

Best regards,
Acme Kenya Ltd
```

---

## Server Actions (Custom Functions)

### Function 1 - Calculate Customer Discount
```javascript
// Name: calculate_customer_discount
// Trigger: Before Invoice Create/Update
// Description: Applies tiered discount based on customer segment

function calculateDiscount(customer, invoiceTotal) {
  const segments = {
    'Corporate': 0.10,    // 10% discount
    'Government': 0.15,   // 15% discount
    'SME': 0.05,          // 5% discount
    'Individual': 0       // No discount
  };
  
  const segment = customer.customer_segment || 'Individual';
  const discountRate = segments[segment] || 0;
  
  return invoiceTotal * discountRate;
}
```

### Function 2 - Update Loyalty Points
```javascript
// Name: update_loyalty_points
// Trigger: After Invoice Paid
// Description: Awards loyalty points based on invoice amount

function updateLoyaltyPoints(invoice) {
  const pointsPerKES = 0.01; // 1 point per 100 KES
  const newPoints = Math.floor(invoice.total * pointsPerKES);
  
  // Update customer loyalty_points
  customer.loyalty_points += newPoints;
  
  return {
    pointsAwarded: newPoints,
    totalPoints: customer.loyalty_points
  };
}
```

---

## Approval Workflows

### Workflow 1 - Expense Approval
| Field | Value |
|-------|-------|
| **Name** | Expense Claim Approval |
| **Entity Type** | expenses |
| **Active** | Yes |

**Conditions:**
- If amount <= 10,000: Single approval (Manager)
- If amount <= 50,000: Two approvals (Manager → Finance)
- If amount > 50,000: Three approvals (Manager → Finance → CEO)

**Steps:**
| Step | Approver | Condition |
|------|----------|-----------|
| 1 | Direct Manager | Always |
| 2 | Finance Manager | amount > 10,000 |
| 3 | CEO | amount > 50,000 |

---

### Workflow 2 - Purchase Order Approval
| Field | Value |
|-------|-------|
| **Name** | Purchase Order Approval |
| **Entity Type** | purchase_orders |
| **Active** | Yes |

**Steps:**
| Step | Approver | Condition |
|------|----------|-----------|
| 1 | Department Head | Always |
| 2 | Finance Manager | total > 100,000 |
| 3 | CFO | total > 500,000 |
| 4 | CEO | total > 1,000,000 |

---

## Reports (Custom)

### Report 1 - Sales by Customer Segment
| Field | Value |
|-------|-------|
| **Name** | Sales by Customer Segment |
| **Model** | invoices |
| **Group By** | contact.customer_segment |
| **Measures** | COUNT(id), SUM(total), AVG(total) |
| **Filters** | status IN ('paid', 'partial'), date range |

### Report 2 - Product Performance
| Field | Value |
|-------|-------|
| **Name** | Product Performance Report |
| **Model** | invoice_items |
| **Group By** | product.category, product.name |
| **Measures** | SUM(quantity), SUM(line_total), profit margin |
| **Filters** | date range, category |

### Report 3 - Employee Expense Analysis
| Field | Value |
|-------|-------|
| **Name** | Employee Expense Analysis |
| **Model** | expenses |
| **Group By** | employee, category, month |
| **Measures** | COUNT(id), SUM(amount), budget variance |
| **Filters** | status = 'approved', date range |
