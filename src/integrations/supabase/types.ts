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
      app_role:
        | "super_admin"
        | "owner"
        | "admin"
        | "accountant"
        | "staff"
        | "viewer"
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
      app_role: [
        "super_admin",
        "owner",
        "admin",
        "accountant",
        "staff",
        "viewer",
      ],
    },
  },
} as const
