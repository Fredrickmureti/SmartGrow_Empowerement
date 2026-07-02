-- Add new values to the payment_method enum for M-Pesa and Mobile Money support
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'mpesa';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'mobile_money';