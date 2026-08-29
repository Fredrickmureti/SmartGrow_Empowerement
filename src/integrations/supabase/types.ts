export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          code: string
          created_at: string
          current_balance: number
          description: string | null
          id: string
          is_active: boolean
          is_system: boolean
          name: string
          opening_balance: number
          organization_id: string
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          code: string
          created_at?: string
          current_balance?: number
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name: string
          opening_balance?: number
          organization_id: string
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          code?: string
          created_at?: string
          current_balance?: number
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          name?: string
          opening_balance?: number
          organization_id?: string
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          business_id: string | null
          changes_summary: string | null
          created_at: string
          entity_id: string | null
          entity_name: string | null
          entity_type: string
          id: string
          ip_address: string | null
          new_values: Json | null
          old_values: Json | null
          organization_id: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          business_id?: string | null
          changes_summary?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type: string
          id?: string
          ip_address?: string | null
          new_values?: Json | null
          old_values?: Json | null
          organization_id: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          business_id?: string | null
          changes_summary?: string | null
          created_at?: string
          entity_id?: string | null
          entity_name?: string | null
          entity_type?: string
          id?: string
          ip_address?: string | null
          new_values?: Json | null
          old_values?: Json | null
          organization_id?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_accounts: {
        Row: {
          account_id: string | null
          account_number: string | null
          bank_name: string | null
          created_at: string
          currency: string
          current_balance: number
          id: string
          is_active: boolean
          name: string
          opening_balance: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          account_number?: string | null
          bank_name?: string | null
          created_at?: string
          currency?: string
          current_balance?: number
          id?: string
          is_active?: boolean
          name: string
          opening_balance?: number
          organization_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          account_number?: string | null
          bank_name?: string | null
          created_at?: string
          currency?: string
          current_balance?: number
          id?: string
          is_active?: boolean
          name?: string
          opening_balance?: number
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bill_items: {
        Row: {
          account_id: string | null
          bill_id: string
          created_at: string
          description: string
          id: string
          line_total: number
          quantity: number
          sort_order: number
          tax_amount: number
          tax_rate: number
          unit_price: number
        }
        Insert: {
          account_id?: string | null
          bill_id: string
          created_at?: string
          description: string
          id?: string
          line_total?: number
          quantity?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
          unit_price?: number
        }
        Update: {
          account_id?: string | null
          bill_id?: string
          created_at?: string
          description?: string
          id?: string
          line_total?: number
          quantity?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "bill_items_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bill_items_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["id"]
          },
        ]
      }
      bills: {
        Row: {
          amount_paid: number
          bill_number: string
          created_at: string
          created_by: string | null
          currency: string
          due_date: string
          id: string
          issue_date: string
          notes: string | null
          organization_id: string
          status: Database["public"]["Enums"]["bill_status"]
          subtotal: number
          tax_amount: number
          total: number
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          amount_paid?: number
          bill_number: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string
          id?: string
          issue_date?: string
          notes?: string | null
          organization_id: string
          status?: Database["public"]["Enums"]["bill_status"]
          subtotal?: number
          tax_amount?: number
          total?: number
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          amount_paid?: number
          bill_number?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string
          id?: string
          issue_date?: string
          notes?: string | null
          organization_id?: string
          status?: Database["public"]["Enums"]["bill_status"]
          subtotal?: number
          tax_amount?: number
          total?: number
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bills_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      branches: {
        Row: {
          address: string | null
          business_id: string
          city: string | null
          code: string | null
          country: string | null
          created_at: string
          default_warehouse_id: string | null
          email: string | null
          id: string
          invoice_prefix_suffix: string | null
          is_active: boolean | null
          is_headquarters: boolean | null
          logo_url: string | null
          name: string
          organization_id: string
          phone: string | null
          postal_code: string | null
          receipt_footer: string | null
          receipt_header: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          business_id: string
          city?: string | null
          code?: string | null
          country?: string | null
          created_at?: string
          default_warehouse_id?: string | null
          email?: string | null
          id?: string
          invoice_prefix_suffix?: string | null
          is_active?: boolean | null
          is_headquarters?: boolean | null
          logo_url?: string | null
          name: string
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          receipt_footer?: string | null
          receipt_header?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          business_id?: string
          city?: string | null
          code?: string | null
          country?: string | null
          created_at?: string
          default_warehouse_id?: string | null
          email?: string | null
          id?: string
          invoice_prefix_suffix?: string | null
          is_active?: boolean | null
          is_headquarters?: boolean | null
          logo_url?: string | null
          name?: string
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          receipt_footer?: string | null
          receipt_header?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branches_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      businesses: {
        Row: {
          address: string | null
          archived_at: string | null
          base_currency: string
          bill_prefix: string | null
          business_type: string | null
          city: string | null
          cost_model: string
          country: string
          created_at: string
          credit_note_prefix: string | null
          date_format: string | null
          default_tax_rate_id: string | null
          email: string | null
          email_display_name: string | null
          email_reply_to: string | null
          estimate_prefix: string | null
          finance_readiness: string
          finance_readiness_checked_at: string | null
          finance_readiness_reason: string | null
          fiscal_year_start: number | null
          id: string
          industry: string | null
          invoice_prefix: string | null
          is_active: boolean | null
          legal_name: string | null
          logo_url: string | null
          name: string
          number_format: string | null
          organization_id: string
          phone: string | null
          postal_code: string | null
          proforma_prefix: string | null
          receipt_engine_v2: boolean
          receipt_settings: Json
          receipt_theme: Json | null
          registration_number: string | null
          sales_return_prefix: string | null
          setup_wizard_completed: boolean | null
          setup_wizard_step: number | null
          state: string | null
          tax_id: string | null
          timezone: string | null
          updated_at: string
          use_holding_accounts: boolean
          website: string | null
          week_starts_on: number
          weekly_hours_target: number
        }
        Insert: {
          address?: string | null
          archived_at?: string | null
          base_currency?: string
          bill_prefix?: string | null
          business_type?: string | null
          city?: string | null
          cost_model?: string
          country?: string
          created_at?: string
          credit_note_prefix?: string | null
          date_format?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          email_display_name?: string | null
          email_reply_to?: string | null
          estimate_prefix?: string | null
          finance_readiness?: string
          finance_readiness_checked_at?: string | null
          finance_readiness_reason?: string | null
          fiscal_year_start?: number | null
          id?: string
          industry?: string | null
          invoice_prefix?: string | null
          is_active?: boolean | null
          legal_name?: string | null
          logo_url?: string | null
          name: string
          number_format?: string | null
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          proforma_prefix?: string | null
          receipt_engine_v2?: boolean
          receipt_settings?: Json
          receipt_theme?: Json | null
          registration_number?: string | null
          sales_return_prefix?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          state?: string | null
          tax_id?: string | null
          timezone?: string | null
          updated_at?: string
          use_holding_accounts?: boolean
          website?: string | null
          week_starts_on?: number
          weekly_hours_target?: number
        }
        Update: {
          address?: string | null
          archived_at?: string | null
          base_currency?: string
          bill_prefix?: string | null
          business_type?: string | null
          city?: string | null
          cost_model?: string
          country?: string
          created_at?: string
          credit_note_prefix?: string | null
          date_format?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          email_display_name?: string | null
          email_reply_to?: string | null
          estimate_prefix?: string | null
          finance_readiness?: string
          finance_readiness_checked_at?: string | null
          finance_readiness_reason?: string | null
          fiscal_year_start?: number | null
          id?: string
          industry?: string | null
          invoice_prefix?: string | null
          is_active?: boolean | null
          legal_name?: string | null
          logo_url?: string | null
          name?: string
          number_format?: string | null
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          proforma_prefix?: string | null
          receipt_engine_v2?: boolean
          receipt_settings?: Json
          receipt_theme?: Json | null
          registration_number?: string | null
          sales_return_prefix?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          state?: string | null
          tax_id?: string | null
          timezone?: string | null
          updated_at?: string
          use_holding_accounts?: boolean
          website?: string | null
          week_starts_on?: number
          weekly_hours_target?: number
        }
        Relationships: [
          {
            foreignKeyName: "businesses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          organization_id: string
          phone: string | null
          postal_code: string | null
          state: string | null
          tax_id: string | null
          type: Database["public"]["Enums"]["contact_type"]
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_id?: string | null
          type?: Database["public"]["Enums"]["contact_type"]
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_id?: string | null
          type?: Database["public"]["Enums"]["contact_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      currencies: {
        Row: {
          code: string
          created_at: string
          decimal_places: number
          id: string
          is_active: boolean
          name: string
          organization_id: string
          symbol: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          decimal_places?: number
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          symbol?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          decimal_places?: number
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          symbol?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rates: {
        Row: {
          created_at: string
          from_currency: string
          id: string
          organization_id: string
          rate: number
          rate_date: string
          source: string | null
          to_currency: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          from_currency: string
          id?: string
          organization_id: string
          rate: number
          rate_date?: string
          source?: string | null
          to_currency: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          from_currency?: string
          id?: string
          organization_id?: string
          rate?: number
          rate_date?: string
          source?: string | null
          to_currency?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exchange_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      fiscal_periods: {
        Row: {
          closed_at: string | null
          created_at: string
          end_date: string
          id: string
          is_closed: boolean
          name: string
          organization_id: string
          start_date: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          end_date: string
          id?: string
          is_closed?: boolean
          name: string
          organization_id: string
          start_date: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          end_date?: string
          id?: string
          is_closed?: boolean
          name?: string
          organization_id?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          created_at: string
          description: string
          discount_percent: number
          id: string
          invoice_id: string
          line_total: number
          product_id: string | null
          quantity: number
          sort_order: number
          tax_amount: number
          tax_rate: number
          unit_price: number
        }
        Insert: {
          created_at?: string
          description: string
          discount_percent?: number
          id?: string
          invoice_id: string
          line_total?: number
          product_id?: string | null
          quantity?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
          unit_price?: number
        }
        Update: {
          created_at?: string
          description?: string
          discount_percent?: number
          id?: string
          invoice_id?: string
          line_total?: number
          product_id?: string | null
          quantity?: number
          sort_order?: number
          tax_amount?: number
          tax_rate?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_paid: number
          contact_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          discount_amount: number
          due_date: string
          id: string
          invoice_number: string
          issue_date: string
          notes: string | null
          organization_id: string
          status: Database["public"]["Enums"]["invoice_status"]
          subtotal: number
          tax_amount: number
          terms: string | null
          total: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          discount_amount?: number
          due_date?: string
          id?: string
          invoice_number: string
          issue_date?: string
          notes?: string | null
          organization_id: string
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal?: number
          tax_amount?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          discount_amount?: number
          due_date?: string
          id?: string
          invoice_number?: string
          issue_date?: string
          notes?: string | null
          organization_id?: string
          status?: Database["public"]["Enums"]["invoice_status"]
          subtotal?: number
          tax_amount?: number
          terms?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          created_at: string
          created_by: string | null
          currency: string
          description: string | null
          entry_date: string
          entry_number: string
          fiscal_period_id: string | null
          id: string
          organization_id: string
          posted_at: string | null
          reference: string | null
          source_doc_id: string | null
          source_doc_type: string | null
          source_module: string | null
          status: Database["public"]["Enums"]["journal_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          entry_date?: string
          entry_number: string
          fiscal_period_id?: string | null
          id?: string
          organization_id: string
          posted_at?: string | null
          reference?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_module?: string | null
          status?: Database["public"]["Enums"]["journal_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          entry_date?: string
          entry_number?: string
          fiscal_period_id?: string | null
          id?: string
          organization_id?: string
          posted_at?: string | null
          reference?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_module?: string | null
          status?: Database["public"]["Enums"]["journal_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_fiscal_period_id_fkey"
            columns: ["fiscal_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entry_lines: {
        Row: {
          account_id: string
          contact_id: string | null
          created_at: string
          credit: number
          debit: number
          description: string | null
          id: string
          journal_entry_id: string
          sort_order: number
        }
        Insert: {
          account_id: string
          contact_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description?: string | null
          id?: string
          journal_entry_id: string
          sort_order?: number
        }
        Update: {
          account_id?: string
          contact_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description?: string | null
          id?: string
          journal_entry_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "journal_entry_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          employee_id: string | null
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string
          permission_group_ids: string[]
          role: Database["public"]["Enums"]["app_role"]
          token: string
          user_type: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id: string
          permission_group_ids?: string[]
          role?: Database["public"]["Enums"]["app_role"]
          token?: string
          user_type?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string
          permission_group_ids?: string[]
          role?: Database["public"]["Enums"]["app_role"]
          token?: string
          user_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by_platform_admin: boolean
          deletion_cancelled_at: string | null
          deletion_grace_days: number | null
          deletion_reason: string | null
          deletion_requested_by: string | null
          deletion_scheduled_at: string | null
          deletion_status: string
          edge_allowed_origins: string[]
          external_customer_id: string | null
          external_subscription_id: string | null
          fiscalyear_lock_date: string | null
          governance_mode: string
          id: string
          is_suspended: boolean | null
          name: string
          onboarding_idempotency_key: string | null
          owner_user_id: string | null
          period_lock_date: string | null
          scheduled_deletion_at: string | null
          setup_wizard_completed: boolean | null
          setup_wizard_step: number | null
          slug: string
          subscription_ends_at: string | null
          subscription_plan_id: string | null
          subscription_started_at: string | null
          subscription_status: string | null
          suspended_at: string | null
          suspended_reason: string | null
          tax_lock_date: string | null
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_platform_admin?: boolean
          deletion_cancelled_at?: string | null
          deletion_grace_days?: number | null
          deletion_reason?: string | null
          deletion_requested_by?: string | null
          deletion_scheduled_at?: string | null
          deletion_status?: string
          edge_allowed_origins?: string[]
          external_customer_id?: string | null
          external_subscription_id?: string | null
          fiscalyear_lock_date?: string | null
          governance_mode?: string
          id?: string
          is_suspended?: boolean | null
          name: string
          onboarding_idempotency_key?: string | null
          owner_user_id?: string | null
          period_lock_date?: string | null
          scheduled_deletion_at?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          slug: string
          subscription_ends_at?: string | null
          subscription_plan_id?: string | null
          subscription_started_at?: string | null
          subscription_status?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_lock_date?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_platform_admin?: boolean
          deletion_cancelled_at?: string | null
          deletion_grace_days?: number | null
          deletion_reason?: string | null
          deletion_requested_by?: string | null
          deletion_scheduled_at?: string | null
          deletion_status?: string
          edge_allowed_origins?: string[]
          external_customer_id?: string | null
          external_subscription_id?: string | null
          fiscalyear_lock_date?: string | null
          governance_mode?: string
          id?: string
          is_suspended?: boolean | null
          name?: string
          onboarding_idempotency_key?: string | null
          owner_user_id?: string | null
          period_lock_date?: string | null
          scheduled_deletion_at?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          slug?: string
          subscription_ends_at?: string | null
          subscription_plan_id?: string | null
          subscription_started_at?: string | null
          subscription_status?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_lock_date?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          bill_id: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          direction: Database["public"]["Enums"]["payment_direction"]
          id: string
          invoice_id: string | null
          method: string | null
          notes: string | null
          organization_id: string
          payment_date: string
          reference: string | null
          updated_at: string
        }
        Insert: {
          amount?: number
          bank_account_id?: string | null
          bill_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          direction?: Database["public"]["Enums"]["payment_direction"]
          id?: string
          invoice_id?: string | null
          method?: string | null
          notes?: string | null
          organization_id: string
          payment_date?: string
          reference?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          bill_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          direction?: Database["public"]["Enums"]["payment_direction"]
          id?: string
          invoice_id?: string | null
          method?: string | null
          notes?: string | null
          organization_id?: string
          payment_date?: string
          reference?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_secret: boolean | null
          setting_key: string
          setting_type: string
          setting_value: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_secret?: boolean | null
          setting_key: string
          setting_type?: string
          setting_value?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_secret?: boolean | null
          setting_key?: string
          setting_type?: string
          setting_value?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          cost_price: number
          created_at: string
          description: string | null
          expense_account_id: string | null
          id: string
          income_account_id: string | null
          is_active: boolean
          name: string
          organization_id: string
          sku: string | null
          tax_rate: number
          type: Database["public"]["Enums"]["product_type"]
          unit_price: number
          updated_at: string
        }
        Insert: {
          cost_price?: number
          created_at?: string
          description?: string | null
          expense_account_id?: string | null
          id?: string
          income_account_id?: string | null
          is_active?: boolean
          name: string
          organization_id: string
          sku?: string | null
          tax_rate?: number
          type?: Database["public"]["Enums"]["product_type"]
          unit_price?: number
          updated_at?: string
        }
        Update: {
          cost_price?: number
          created_at?: string
          description?: string | null
          expense_account_id?: string | null
          id?: string
          income_account_id?: string | null
          is_active?: boolean
          name?: string
          organization_id?: string
          sku?: string | null
          tax_rate?: number
          type?: Database["public"]["Enums"]["product_type"]
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          engagement_score: number | null
          full_name: string | null
          id: string
          last_activity_at: string | null
          last_login_at: string | null
          last_org_id: string | null
          login_count: number | null
          phone: string | null
          preferred_currency: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          engagement_score?: number | null
          full_name?: string | null
          id?: string
          last_activity_at?: string | null
          last_login_at?: string | null
          last_org_id?: string | null
          login_count?: number | null
          phone?: string | null
          preferred_currency?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          engagement_score?: number | null
          full_name?: string | null
          id?: string
          last_activity_at?: string | null
          last_login_at?: string | null
          last_org_id?: string | null
          login_count?: number | null
          phone?: string | null
          preferred_currency?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_last_org_id_fkey"
            columns: ["last_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_group_items: {
        Row: {
          created_at: string
          id: string
          sort_order: number
          tax_group_id: string
          tax_rate_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          sort_order?: number
          tax_group_id: string
          tax_rate_id: string
        }
        Update: {
          created_at?: string
          id?: string
          sort_order?: number
          tax_group_id?: string
          tax_rate_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_group_items_tax_group_id_fkey"
            columns: ["tax_group_id"]
            isOneToOne: false
            referencedRelation: "tax_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_group_items_tax_rate_id_fkey"
            columns: ["tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_groups: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_rates: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          is_compound: boolean
          name: string
          organization_id: string
          rate: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_compound?: boolean
          name: string
          organization_id: string
          rate?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_compound?: boolean
          name?: string
          organization_id?: string
          rate?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_pins: {
        Row: {
          created_at: string
          device_fingerprint: string | null
          failed_attempts: number
          id: string
          is_active: boolean
          last_used_at: string | null
          locked_until: string | null
          pin_hash: string
          pin_length: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_fingerprint?: string | null
          failed_attempts?: number
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash: string
          pin_length?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_fingerprint?: string | null
          failed_attempts?: number
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          locked_until?: string | null
          pin_hash?: string
          pin_length?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          is_active: boolean | null
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
          user_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          organization_id: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
          user_type?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean | null
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
          user_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_user_organizations: { Args: { _user_id: string }; Returns: string[] }
      has_role: {
        Args: {
          _organization_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_org_manager: {
        Args: { _organization_id: string; _user_id: string }
        Returns: boolean
      }
      is_org_member: {
        Args: { _organization_id: string; _user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      account_type: "asset" | "liability" | "equity" | "income" | "expense"
      app_role:
        | "super_admin"
        | "owner"
        | "admin"
        | "accountant"
        | "staff"
        | "viewer"
        | "internal"
        | "portal"
        | "cashier"
      bill_status:
        | "draft"
        | "open"
        | "partial"
        | "paid"
        | "overdue"
        | "cancelled"
      contact_type: "customer" | "vendor" | "both"
      invoice_status:
        | "draft"
        | "sent"
        | "viewed"
        | "partial"
        | "paid"
        | "overdue"
        | "cancelled"
      journal_status: "draft" | "posted" | "void"
      payment_direction: "received" | "made"
      product_type: "product" | "service"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: ["asset", "liability", "equity", "income", "expense"],
      app_role: [
        "super_admin",
        "owner",
        "admin",
        "accountant",
        "staff",
        "viewer",
        "internal",
        "portal",
        "cashier",
      ],
      bill_status: ["draft", "open", "partial", "paid", "overdue", "cancelled"],
      contact_type: ["customer", "vendor", "both"],
      invoice_status: [
        "draft",
        "sent",
        "viewed",
        "partial",
        "paid",
        "overdue",
        "cancelled",
      ],
      journal_status: ["draft", "posted", "void"],
      payment_direction: ["received", "made"],
      product_type: ["product", "service"],
    },
  },
} as const
