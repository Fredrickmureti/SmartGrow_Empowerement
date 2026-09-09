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
      account_change_audit_log: {
        Row: {
          account_id: string | null
          business_id: string | null
          change_type: string
          changed_at: string
          changed_by: string | null
          id: string
          new_value: Json | null
          old_value: Json | null
          organization_id: string | null
          reason: string | null
        }
        Insert: {
          account_id?: string | null
          business_id?: string | null
          change_type: string
          changed_at?: string
          changed_by?: string | null
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          organization_id?: string | null
          reason?: string | null
        }
        Update: {
          account_id?: string | null
          business_id?: string | null
          change_type?: string
          changed_at?: string
          changed_by?: string | null
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          organization_id?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      account_detail_type_catalog: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at: string
          description: string | null
          detail_type: string
          display_label: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at?: string
          description?: string | null
          detail_type: string
          display_label: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          created_at?: string
          description?: string | null
          detail_type?: string
          display_label?: string
        }
        Relationships: []
      }
      account_role_eligibility: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          detail_type: string
          priority: number
          role_key: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          detail_type: string
          priority?: number
          role_key: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          detail_type?: string
          priority?: number
          role_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_role_eligibility_account_type_detail_type_fkey"
            columns: ["account_type", "detail_type"]
            isOneToOne: false
            referencedRelation: "account_detail_type_catalog"
            referencedColumns: ["account_type", "detail_type"]
          },
          {
            foreignKeyName: "account_role_eligibility_role_key_fkey"
            columns: ["role_key"]
            isOneToOne: false
            referencedRelation: "system_account_roles"
            referencedColumns: ["role_key"]
          },
        ]
      }
      accounting_events: {
        Row: {
          amount: number | null
          branch_id: string | null
          business_date: string | null
          business_id: string | null
          business_idempotency_key: string
          created_at: string
          currency_code: string | null
          event_kind: string
          id: string
          journal_entry_id: string | null
          last_diagnostic: Json | null
          org_id: string
          posted_at: string | null
          producer: string
          producer_doc_id: string
          producer_doc_type: string
          requested_at: string
          state: string
          updated_at: string
          validated_at: string | null
          version: number
        }
        Insert: {
          amount?: number | null
          branch_id?: string | null
          business_date?: string | null
          business_id?: string | null
          business_idempotency_key: string
          created_at?: string
          currency_code?: string | null
          event_kind: string
          id?: string
          journal_entry_id?: string | null
          last_diagnostic?: Json | null
          org_id: string
          posted_at?: string | null
          producer: string
          producer_doc_id: string
          producer_doc_type: string
          requested_at?: string
          state?: string
          updated_at?: string
          validated_at?: string | null
          version?: number
        }
        Update: {
          amount?: number | null
          branch_id?: string | null
          business_date?: string | null
          business_id?: string | null
          business_idempotency_key?: string
          created_at?: string
          currency_code?: string | null
          event_kind?: string
          id?: string
          journal_entry_id?: string | null
          last_diagnostic?: Json | null
          org_id?: string
          posted_at?: string | null
          producer?: string
          producer_doc_id?: string
          producer_doc_type?: string
          requested_at?: string
          state?: string
          updated_at?: string
          validated_at?: string | null
          version?: number
        }
        Relationships: []
      }
      accounting_integrity_reports: {
        Row: {
          ap_drift: number
          ar_drift: number
          balance_drifts_count: number
          business_id: string | null
          created_at: string
          details: Json | null
          has_drift: boolean
          id: string
          organization_id: string
          ran_at: string
          total_abs_drift: number
        }
        Insert: {
          ap_drift?: number
          ar_drift?: number
          balance_drifts_count?: number
          business_id?: string | null
          created_at?: string
          details?: Json | null
          has_drift?: boolean
          id?: string
          organization_id: string
          ran_at?: string
          total_abs_drift?: number
        }
        Update: {
          ap_drift?: number
          ar_drift?: number
          balance_drifts_count?: number
          business_id?: string | null
          created_at?: string
          details?: Json | null
          has_drift?: boolean
          id?: string
          organization_id?: string
          ran_at?: string
          total_abs_drift?: number
        }
        Relationships: [
          {
            foreignKeyName: "accounting_integrity_reports_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_integrity_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "accounting_integrity_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "accounting_integrity_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          business_id: string
          cash_flow_category: string | null
          code: string
          created_at: string
          current_balance: number
          description: string | null
          detail_type: string | null
          id: string
          is_active: boolean
          is_header: boolean
          is_system: boolean
          name: string
          opening_balance: number
          organization_id: string
          parent_id: string | null
          system_role: string | null
          template_account_id: string | null
          template_pack_account_id: string | null
          updated_at: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          business_id: string
          cash_flow_category?: string | null
          code: string
          created_at?: string
          current_balance?: number
          description?: string | null
          detail_type?: string | null
          id?: string
          is_active?: boolean
          is_header?: boolean
          is_system?: boolean
          name: string
          opening_balance?: number
          organization_id: string
          parent_id?: string | null
          system_role?: string | null
          template_account_id?: string | null
          template_pack_account_id?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          business_id?: string
          cash_flow_category?: string | null
          code?: string
          created_at?: string
          current_balance?: number
          description?: string | null
          detail_type?: string | null
          id?: string
          is_active?: boolean
          is_header?: boolean
          is_system?: boolean
          name?: string
          opening_balance?: number
          organization_id?: string
          parent_id?: string | null
          system_role?: string | null
          template_account_id?: string | null
          template_pack_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
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
          {
            foreignKeyName: "accounts_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_system_role_fkey"
            columns: ["system_role"]
            isOneToOne: false
            referencedRelation: "system_account_roles"
            referencedColumns: ["role_key"]
          },
          {
            foreignKeyName: "accounts_template_account_id_fkey"
            columns: ["template_account_id"]
            isOneToOne: false
            referencedRelation: "default_chart_of_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_audit_log: {
        Row: {
          action_type: string
          admin_user_id: string | null
          created_at: string
          details: Json | null
          id: string
          ip_address: string | null
          session_id: string | null
          target_entity_id: string | null
          target_entity_type: string | null
          target_org_id: string | null
          user_agent: string | null
        }
        Insert: {
          action_type: string
          admin_user_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          session_id?: string | null
          target_entity_id?: string | null
          target_entity_type?: string | null
          target_org_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action_type?: string
          admin_user_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          session_id?: string | null
          target_entity_id?: string | null
          target_entity_type?: string | null
          target_org_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_audit_log_target_org_id_fkey"
            columns: ["target_org_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "admin_audit_log_target_org_id_fkey"
            columns: ["target_org_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "admin_audit_log_target_org_id_fkey"
            columns: ["target_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_sent_emails: {
        Row: {
          body: string
          created_at: string | null
          error_message: string | null
          id: string
          recipient_count: number | null
          recipient_ids: string[] | null
          recipient_type: string
          sent_by: string | null
          status: string | null
          subject: string
        }
        Insert: {
          body: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          recipient_count?: number | null
          recipient_ids?: string[] | null
          recipient_type: string
          sent_by?: string | null
          status?: string | null
          subject: string
        }
        Update: {
          body?: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          recipient_count?: number | null
          recipient_ids?: string[] | null
          recipient_type?: string
          sent_by?: string | null
          status?: string | null
          subject?: string
        }
        Relationships: []
      }
      ai_advisory_usage: {
        Row: {
          action: string
          app_key: string | null
          branch_id: string | null
          business_id: string
          created_at: string
          feature: string
          id: string
          model_used: string | null
          response_time_ms: number | null
          user_id: string
          was_degraded: boolean
          was_throttled: boolean
        }
        Insert: {
          action: string
          app_key?: string | null
          branch_id?: string | null
          business_id: string
          created_at?: string
          feature: string
          id?: string
          model_used?: string | null
          response_time_ms?: number | null
          user_id: string
          was_degraded?: boolean
          was_throttled?: boolean
        }
        Update: {
          action?: string
          app_key?: string | null
          branch_id?: string | null
          business_id?: string
          created_at?: string
          feature?: string
          id?: string
          model_used?: string | null
          response_time_ms?: number | null
          user_id?: string
          was_degraded?: boolean
          was_throttled?: boolean
        }
        Relationships: []
      }
      ai_api_keys: {
        Row: {
          api_key_encrypted: string | null
          created_at: string | null
          id: string
          is_enabled: boolean | null
          key_name: string
          last_rate_limited_at: string | null
          last_used_at: string | null
          priority: number | null
          provider_id: string
          rate_limit_hits: number | null
          total_requests: number | null
          updated_at: string | null
          vault_secret_id: string | null
        }
        Insert: {
          api_key_encrypted?: string | null
          created_at?: string | null
          id?: string
          is_enabled?: boolean | null
          key_name: string
          last_rate_limited_at?: string | null
          last_used_at?: string | null
          priority?: number | null
          provider_id: string
          rate_limit_hits?: number | null
          total_requests?: number | null
          updated_at?: string | null
          vault_secret_id?: string | null
        }
        Update: {
          api_key_encrypted?: string | null
          created_at?: string | null
          id?: string
          is_enabled?: boolean | null
          key_name?: string
          last_rate_limited_at?: string | null
          last_used_at?: string | null
          priority?: number | null
          provider_id?: string
          rate_limit_hits?: number | null
          total_requests?: number | null
          updated_at?: string | null
          vault_secret_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_api_keys_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "ai_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversation_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          organization_id: string
          role: string
          working_context: Json
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          organization_id: string
          role: string
          working_context?: Json
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          role?: string
          working_context?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversations: {
        Row: {
          app_key: string
          archived_at: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string
          created_by: string
          id: string
          last_message_at: string
          module_key: string | null
          organization_id: string
          record_id: string | null
          record_type: string | null
          scope_level: string
          title: string | null
          updated_at: string
        }
        Insert: {
          app_key?: string
          archived_at?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by: string
          id?: string
          last_message_at?: string
          module_key?: string | null
          organization_id: string
          record_id?: string | null
          record_type?: string | null
          scope_level?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          app_key?: string
          archived_at?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string
          id?: string
          last_message_at?: string
          module_key?: string | null
          organization_id?: string
          record_id?: string | null
          record_type?: string | null
          scope_level?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ai_insights_cache: {
        Row: {
          app_key: string | null
          branch_id: string | null
          business_id: string | null
          content: Json
          created_at: string
          id: string
          input_hash: string | null
          insight_type: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_key?: string | null
          branch_id?: string | null
          business_id?: string | null
          content: Json
          created_at?: string
          id?: string
          input_hash?: string | null
          insight_type: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_key?: string | null
          branch_id?: string | null
          business_id?: string | null
          content?: Json
          created_at?: string
          id?: string
          input_hash?: string | null
          insight_type?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_insights_cache_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_insights_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ai_insights_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "ai_insights_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_providers: {
        Row: {
          available_models: Json | null
          base_url: string
          created_at: string | null
          default_model: string | null
          display_name: string
          id: string
          is_enabled: boolean | null
          priority: number | null
          provider_code: string
          updated_at: string | null
        }
        Insert: {
          available_models?: Json | null
          base_url: string
          created_at?: string | null
          default_model?: string | null
          display_name: string
          id?: string
          is_enabled?: boolean | null
          priority?: number | null
          provider_code: string
          updated_at?: string | null
        }
        Update: {
          available_models?: Json | null
          base_url?: string
          created_at?: string | null
          default_model?: string | null
          display_name?: string
          id?: string
          is_enabled?: boolean | null
          priority?: number | null
          provider_code?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      ai_settings: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          setting_key: string
          setting_type: string | null
          setting_value: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          setting_key: string
          setting_type?: string | null
          setting_value?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          setting_key?: string
          setting_type?: string | null
          setting_value?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      ai_usage_logs: {
        Row: {
          api_key_id: string | null
          app_key: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string | null
          error_message: string | null
          id: string
          model_used: string | null
          organization_id: string | null
          provider_code: string
          request_type: string
          response_time_ms: number | null
          tokens_used: number | null
          user_id: string | null
          was_fallback: boolean | null
          was_rate_limited: boolean | null
        }
        Insert: {
          api_key_id?: string | null
          app_key?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          model_used?: string | null
          organization_id?: string | null
          provider_code: string
          request_type: string
          response_time_ms?: number | null
          tokens_used?: number | null
          user_id?: string | null
          was_fallback?: boolean | null
          was_rate_limited?: boolean | null
        }
        Update: {
          api_key_id?: string | null
          app_key?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          model_used?: string | null
          organization_id?: string | null
          provider_code?: string
          request_type?: string
          response_time_ms?: number | null
          tokens_used?: number | null
          user_id?: string | null
          was_fallback?: boolean | null
          was_rate_limited?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_logs_api_key_id_fkey"
            columns: ["api_key_id"]
            isOneToOne: false
            referencedRelation: "ai_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      analytic_accounts: {
        Row: {
          analytic_type: string | null
          balance: number | null
          business_id: string
          code: string | null
          created_at: string | null
          description: string | null
          group_id: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          parent_id: string | null
          plan_id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          analytic_type?: string | null
          balance?: number | null
          business_id: string
          code?: string | null
          created_at?: string | null
          description?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          parent_id?: string | null
          plan_id: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          analytic_type?: string | null
          balance?: number | null
          business_id?: string
          code?: string | null
          created_at?: string | null
          description?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          parent_id?: string | null
          plan_id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytic_accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_accounts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "analytic_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "analytic_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "analytic_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_accounts_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_accounts_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "analytic_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      analytic_groups: {
        Row: {
          business_id: string
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          sort_order: number | null
          updated_at: string | null
        }
        Insert: {
          business_id: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          sort_order?: number | null
          updated_at?: string | null
        }
        Update: {
          business_id?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          sort_order?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytic_groups_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "analytic_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "analytic_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytic_plans: {
        Row: {
          business_id: string
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          is_required: boolean
          name: string
          organization_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          business_id: string
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          name: string
          organization_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          business_id?: string
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          name?: string
          organization_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytic_plans_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytic_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "analytic_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "analytic_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_dependencies: {
        Row: {
          app_id: string
          auto_install: boolean
          billing_behavior: string
          created_at: string
          dependency_kind: string
          dependency_type: string
          depends_on_app_id: string
          id: string
        }
        Insert: {
          app_id: string
          auto_install?: boolean
          billing_behavior?: string
          created_at?: string
          dependency_kind?: string
          dependency_type?: string
          depends_on_app_id: string
          id?: string
        }
        Update: {
          app_id?: string
          auto_install?: boolean
          billing_behavior?: string
          created_at?: string
          dependency_kind?: string
          dependency_type?: string
          depends_on_app_id?: string
          id?: string
        }
        Relationships: []
      }
      app_included_features: {
        Row: {
          app_id: string
          created_at: string
          feature_key: string
          id: string
        }
        Insert: {
          app_id: string
          created_at?: string
          feature_key: string
          id?: string
        }
        Update: {
          app_id?: string
          created_at?: string
          feature_key?: string
          id?: string
        }
        Relationships: []
      }
      app_install_attempts: {
        Row: {
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          organization_id: string
          outcome: string
          plan_snapshot: Json | null
          requested_app_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          organization_id: string
          outcome: string
          plan_snapshot?: Json | null
          requested_app_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          organization_id?: string
          outcome?: string
          plan_snapshot?: Json | null
          requested_app_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_install_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "app_install_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "app_install_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_launch_notifications: {
        Row: {
          app_id: string
          id: string
          notified_at: string | null
          organization_id: string | null
          requested_at: string
          user_id: string
        }
        Insert: {
          app_id: string
          id?: string
          notified_at?: string | null
          organization_id?: string | null
          requested_at?: string
          user_id: string
        }
        Update: {
          app_id?: string
          id?: string
          notified_at?: string | null
          organization_id?: string | null
          requested_at?: string
          user_id?: string
        }
        Relationships: []
      }
      app_regions: {
        Row: {
          app_id: string
          country_code: string
          created_at: string
          is_available: boolean
          notes: string | null
          updated_at: string
        }
        Insert: {
          app_id: string
          country_code: string
          created_at?: string
          is_available?: boolean
          notes?: string | null
          updated_at?: string
        }
        Update: {
          app_id?: string
          country_code?: string
          created_at?: string
          is_available?: boolean
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_regions_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "platform_apps"
            referencedColumns: ["id"]
          },
        ]
      }
      app_setup_status: {
        Row: {
          app_id: string
          blocking_reasons: Json
          created_at: string
          id: string
          last_checked_at: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          app_id: string
          blocking_reasons?: Json
          created_at?: string
          id?: string
          last_checked_at?: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          app_id?: string
          blocking_reasons?: Json
          created_at?: string
          id?: string
          last_checked_at?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_setup_status_app_id_fkey"
            columns: ["app_id"]
            isOneToOne: false
            referencedRelation: "platform_apps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_setup_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "app_setup_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "app_setup_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_history: {
        Row: {
          action: string
          actor_user_id: string | null
          approved_at: string | null
          approved_by: string | null
          client_token: string | null
          comments: string | null
          event_hash: string | null
          event_seq: number | null
          event_type: string
          id: string
          payload: Json
          prev_hash: string | null
          recorded_at: string
          request_id: string
          step_number: number
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          client_token?: string | null
          comments?: string | null
          event_hash?: string | null
          event_seq?: number | null
          event_type?: string
          id?: string
          payload?: Json
          prev_hash?: string | null
          recorded_at?: string
          request_id: string
          step_number: number
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          client_token?: string | null
          comments?: string | null
          event_hash?: string | null
          event_seq?: number | null
          event_type?: string
          id?: string
          payload?: Json
          prev_hash?: string | null
          recorded_at?: string
          request_id?: string
          step_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_history_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_history_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "reversal_register"
            referencedColumns: ["approval_request_id"]
          },
        ]
      }
      approval_request_approvers: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          permission_group_id: string | null
          principal_role: string | null
          principal_type: string
          principal_user_id: string | null
          request_id: string
          step_number: number
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          permission_group_id?: string | null
          principal_role?: string | null
          principal_type: string
          principal_user_id?: string | null
          request_id: string
          step_number: number
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          permission_group_id?: string | null
          principal_role?: string | null
          principal_type?: string
          principal_user_id?: string | null
          request_id?: string
          step_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_request_approvers_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_request_approvers_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "reversal_register"
            referencedColumns: ["approval_request_id"]
          },
        ]
      }
      approval_request_steps: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          is_required: boolean
          min_approvals: number
          name: string | null
          organization_id: string
          request_id: string
          status: string
          step_number: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          is_required?: boolean
          min_approvals?: number
          name?: string | null
          organization_id: string
          request_id: string
          status?: string
          step_number: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          is_required?: boolean
          min_approvals?: number
          name?: string | null
          organization_id?: string
          request_id?: string
          status?: string
          step_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_request_steps_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_request_steps_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "reversal_register"
            referencedColumns: ["approval_request_id"]
          },
        ]
      }
      approval_requests: {
        Row: {
          action_key: string | null
          business_id: string | null
          completed_at: string | null
          context_snapshot: Json
          created_at: string
          current_step: number | null
          dedupe_hash: string | null
          entity_id: string
          entity_reference: string | null
          entity_type: string
          id: string
          idempotency_key: string | null
          notes: string | null
          organization_id: string
          payload_snapshot: Json
          policy_version: number | null
          requested_at: string | null
          requested_by: string | null
          rule_snapshot: Json | null
          status: string | null
          total_steps: number
          updated_at: string
          workflow_id: string | null
          workflow_snapshot: Json | null
          workflow_version: number | null
        }
        Insert: {
          action_key?: string | null
          business_id?: string | null
          completed_at?: string | null
          context_snapshot?: Json
          created_at?: string
          current_step?: number | null
          dedupe_hash?: string | null
          entity_id: string
          entity_reference?: string | null
          entity_type: string
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          organization_id: string
          payload_snapshot?: Json
          policy_version?: number | null
          requested_at?: string | null
          requested_by?: string | null
          rule_snapshot?: Json | null
          status?: string | null
          total_steps?: number
          updated_at?: string
          workflow_id?: string | null
          workflow_snapshot?: Json | null
          workflow_version?: number | null
        }
        Update: {
          action_key?: string | null
          business_id?: string | null
          completed_at?: string | null
          context_snapshot?: Json
          created_at?: string
          current_step?: number | null
          dedupe_hash?: string | null
          entity_id?: string
          entity_reference?: string | null
          entity_type?: string
          id?: string
          idempotency_key?: string | null
          notes?: string | null
          organization_id?: string
          payload_snapshot?: Json
          policy_version?: number | null
          requested_at?: string | null
          requested_by?: string | null
          rule_snapshot?: Json | null
          status?: string | null
          total_steps?: number
          updated_at?: string
          workflow_id?: string | null
          workflow_snapshot?: Json | null
          workflow_version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_action_key_fkey"
            columns: ["action_key"]
            isOneToOne: false
            referencedRelation: "governance_action_registry"
            referencedColumns: ["action_key"]
          },
          {
            foreignKeyName: "approval_requests_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "approval_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "approval_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "approval_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_rule_logs: {
        Row: {
          action_name: string
          approved_at: string | null
          approved_by: string | null
          business_id: string | null
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          notes: string | null
          organization_id: string
          rejected_at: string | null
          rejected_by: string | null
          requested_by: string | null
          rule_id: string
          status: string
        }
        Insert: {
          action_name: string
          approved_at?: string | null
          approved_by?: string | null
          business_id?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          notes?: string | null
          organization_id: string
          rejected_at?: string | null
          rejected_by?: string | null
          requested_by?: string | null
          rule_id: string
          status?: string
        }
        Update: {
          action_name?: string
          approved_at?: string | null
          approved_by?: string | null
          business_id?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          notes?: string | null
          organization_id?: string
          rejected_at?: string | null
          rejected_by?: string | null
          requested_by?: string | null
          rule_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_rule_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_rule_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "approval_rule_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "approval_rule_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_rule_logs_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "approval_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_rules: {
        Row: {
          action_name: string
          approval_mode: string
          approver_role: string | null
          approver_type: string
          approver_user_id: string | null
          business_id: string | null
          condition: Json | null
          created_at: string
          created_by: string | null
          description: string | null
          entity_type: string
          id: string
          is_active: boolean
          organization_id: string
          requires_review: boolean
          requires_review_reason: string | null
          threshold_field: string | null
          threshold_operator: string | null
          threshold_value: number | null
          updated_at: string
        }
        Insert: {
          action_name: string
          approval_mode?: string
          approver_role?: string | null
          approver_type?: string
          approver_user_id?: string | null
          business_id?: string | null
          condition?: Json | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_type: string
          id?: string
          is_active?: boolean
          organization_id: string
          requires_review?: boolean
          requires_review_reason?: string | null
          threshold_field?: string | null
          threshold_operator?: string | null
          threshold_value?: number | null
          updated_at?: string
        }
        Update: {
          action_name?: string
          approval_mode?: string
          approver_role?: string | null
          approver_type?: string
          approver_user_id?: string | null
          business_id?: string | null
          condition?: Json | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          entity_type?: string
          id?: string
          is_active?: boolean
          organization_id?: string
          requires_review?: boolean
          requires_review_reason?: string | null
          threshold_field?: string | null
          threshold_operator?: string | null
          threshold_value?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_rules_action_name_fk"
            columns: ["action_name"]
            isOneToOne: false
            referencedRelation: "governance_action_registry"
            referencedColumns: ["action_key"]
          },
          {
            foreignKeyName: "approval_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "approval_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "approval_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_workflow_steps: {
        Row: {
          action_key: string | null
          approver_id: string | null
          created_at: string
          id: string
          is_required: boolean | null
          role: string | null
          step_order: number
          workflow_id: string
        }
        Insert: {
          action_key?: string | null
          approver_id?: string | null
          created_at?: string
          id?: string
          is_required?: boolean | null
          role?: string | null
          step_order: number
          workflow_id: string
        }
        Update: {
          action_key?: string | null
          approver_id?: string | null
          created_at?: string
          id?: string
          is_required?: boolean | null
          role?: string | null
          step_order?: number
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_workflow_steps_action_key_fkey"
            columns: ["action_key"]
            isOneToOne: false
            referencedRelation: "governance_action_registry"
            referencedColumns: ["action_key"]
          },
          {
            foreignKeyName: "approval_workflow_steps_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "approval_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_workflows: {
        Row: {
          business_id: string | null
          conditions: Json | null
          created_at: string
          definition_hash: string | null
          description: string | null
          entity_type: string
          id: string
          is_active: boolean | null
          is_published: boolean
          name: string
          organization_id: string
          published_at: string | null
          published_by: string | null
          superseded_by: string | null
          updated_at: string
          version: number
        }
        Insert: {
          business_id?: string | null
          conditions?: Json | null
          created_at?: string
          definition_hash?: string | null
          description?: string | null
          entity_type: string
          id?: string
          is_active?: boolean | null
          is_published?: boolean
          name: string
          organization_id: string
          published_at?: string | null
          published_by?: string | null
          superseded_by?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          business_id?: string | null
          conditions?: Json | null
          created_at?: string
          definition_hash?: string | null
          description?: string | null
          entity_type?: string
          id?: string
          is_active?: boolean | null
          is_published?: boolean
          name?: string
          organization_id?: string
          published_at?: string | null
          published_by?: string | null
          superseded_by?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_workflows_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_workflows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "approval_workflows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "approval_workflows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_workflows_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "approval_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_categories: {
        Row: {
          accumulated_depreciation_account_id: string | null
          asset_account_id: string | null
          business_id: string
          created_at: string
          depreciation_account_id: string | null
          depreciation_method: string | null
          depreciation_rate: number | null
          description: string | null
          gain_loss_account_id: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          updated_at: string
          useful_life_years: number | null
        }
        Insert: {
          accumulated_depreciation_account_id?: string | null
          asset_account_id?: string | null
          business_id: string
          created_at?: string
          depreciation_account_id?: string | null
          depreciation_method?: string | null
          depreciation_rate?: number | null
          description?: string | null
          gain_loss_account_id?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          updated_at?: string
          useful_life_years?: number | null
        }
        Update: {
          accumulated_depreciation_account_id?: string | null
          asset_account_id?: string | null
          business_id?: string
          created_at?: string
          depreciation_account_id?: string | null
          depreciation_method?: string | null
          depreciation_rate?: number | null
          description?: string | null
          gain_loss_account_id?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          updated_at?: string
          useful_life_years?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_categories_accumulated_depreciation_account_id_fkey"
            columns: ["accumulated_depreciation_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_accumulated_depreciation_account_id_fkey"
            columns: ["accumulated_depreciation_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_asset_account_id_fkey"
            columns: ["asset_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_asset_account_id_fkey"
            columns: ["asset_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_depreciation_account_id_fkey"
            columns: ["depreciation_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_depreciation_account_id_fkey"
            columns: ["depreciation_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_gain_loss_account_id_fkey"
            columns: ["gain_loss_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_gain_loss_account_id_fkey"
            columns: ["gain_loss_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "asset_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "asset_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_maintenance: {
        Row: {
          asset_id: string
          business_id: string
          cost: number | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          maintenance_date: string
          maintenance_type: string | null
          next_maintenance_date: string | null
          notes: string | null
          organization_id: string
          vendor_id: string | null
        }
        Insert: {
          asset_id: string
          business_id: string
          cost?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          maintenance_date: string
          maintenance_type?: string | null
          next_maintenance_date?: string | null
          notes?: string | null
          organization_id: string
          vendor_id?: string | null
        }
        Update: {
          asset_id?: string
          business_id?: string
          cost?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          maintenance_date?: string
          maintenance_type?: string | null
          next_maintenance_date?: string | null
          notes?: string | null
          organization_id?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_maintenance_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "fixed_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "asset_maintenance_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "asset_maintenance_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_maintenance_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
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
      automated_action_logs: {
        Row: {
          action_id: string
          business_id: string | null
          completed_at: string | null
          created_at: string
          error_details: Json | null
          error_message: string | null
          id: string
          organization_id: string
          retry_count: number | null
          started_at: string | null
          status: string
          steps_executed: Json | null
          target_model: string
          target_record_id: string | null
          trigger_type: string
        }
        Insert: {
          action_id: string
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_details?: Json | null
          error_message?: string | null
          id?: string
          organization_id: string
          retry_count?: number | null
          started_at?: string | null
          status: string
          steps_executed?: Json | null
          target_model: string
          target_record_id?: string | null
          trigger_type: string
        }
        Update: {
          action_id?: string
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_details?: Json | null
          error_message?: string | null
          id?: string
          organization_id?: string
          retry_count?: number | null
          started_at?: string | null
          status?: string
          steps_executed?: Json | null
          target_model?: string
          target_record_id?: string | null
          trigger_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "automated_action_logs_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "automated_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automated_action_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automated_action_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "automated_action_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "automated_action_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      automated_action_steps: {
        Row: {
          action_config: Json
          action_id: string
          action_type: string
          condition: Json | null
          created_at: string
          id: string
          on_error: string | null
          step_name: string | null
          step_order: number
          updated_at: string
        }
        Insert: {
          action_config?: Json
          action_id: string
          action_type: string
          condition?: Json | null
          created_at?: string
          id?: string
          on_error?: string | null
          step_name?: string | null
          step_order?: number
          updated_at?: string
        }
        Update: {
          action_config?: Json
          action_id?: string
          action_type?: string
          condition?: Json | null
          created_at?: string
          id?: string
          on_error?: string | null
          step_name?: string | null
          step_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automated_action_steps_action_id_fkey"
            columns: ["action_id"]
            isOneToOne: false
            referencedRelation: "automated_actions"
            referencedColumns: ["id"]
          },
        ]
      }
      automated_actions: {
        Row: {
          business_id: string | null
          circuit_broken_at: string | null
          circuit_broken_reason: string | null
          created_at: string
          created_by: string | null
          description: string | null
          filter_domain: Json | null
          id: string
          is_active: boolean | null
          is_circuit_broken: boolean | null
          last_run_at: string | null
          max_retries: number | null
          name: string
          next_run_at: string | null
          organization_id: string
          retry_delay_seconds: number | null
          run_as_user_id: string | null
          schedule_config: Json | null
          schedule_type: string | null
          target_model: string
          trigger_conditions: Json | null
          trigger_type: string
          updated_at: string
          watched_fields: string[] | null
        }
        Insert: {
          business_id?: string | null
          circuit_broken_at?: string | null
          circuit_broken_reason?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          filter_domain?: Json | null
          id?: string
          is_active?: boolean | null
          is_circuit_broken?: boolean | null
          last_run_at?: string | null
          max_retries?: number | null
          name: string
          next_run_at?: string | null
          organization_id: string
          retry_delay_seconds?: number | null
          run_as_user_id?: string | null
          schedule_config?: Json | null
          schedule_type?: string | null
          target_model: string
          trigger_conditions?: Json | null
          trigger_type: string
          updated_at?: string
          watched_fields?: string[] | null
        }
        Update: {
          business_id?: string | null
          circuit_broken_at?: string | null
          circuit_broken_reason?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          filter_domain?: Json | null
          id?: string
          is_active?: boolean | null
          is_circuit_broken?: boolean | null
          last_run_at?: string | null
          max_retries?: number | null
          name?: string
          next_run_at?: string | null
          organization_id?: string
          retry_delay_seconds?: number | null
          run_as_user_id?: string | null
          schedule_config?: Json | null
          schedule_type?: string | null
          target_model?: string
          trigger_conditions?: Json | null
          trigger_type?: string
          updated_at?: string
          watched_fields?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "automated_actions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automated_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "automated_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "automated_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_execution_tracker: {
        Row: {
          automation_id: string
          created_at: string
          execution_count: number
          hour_bucket: string
          id: string
          organization_id: string
        }
        Insert: {
          automation_id: string
          created_at?: string
          execution_count?: number
          hour_bucket?: string
          id?: string
          organization_id: string
        }
        Update: {
          automation_id?: string
          created_at?: string
          execution_count?: number
          hour_bucket?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_execution_tracker_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automated_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "automation_execution_tracker_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "automation_execution_tracker_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "automation_execution_tracker_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_accounts: {
        Row: {
          access_token_encrypted: string | null
          account_id: string | null
          account_number: string | null
          account_type: string | null
          activated_at: string | null
          auto_sync_enabled: boolean | null
          bank_balance_as_of: string | null
          bank_name: string | null
          bank_reported_balance: number | null
          branch_id: string | null
          business_id: string | null
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          currency: string
          current_balance: number | null
          external_account_id: string | null
          id: string
          is_active: boolean
          is_primary: boolean | null
          is_shared: boolean
          last_auto_sync_at: string | null
          lifecycle_status: Database["public"]["Enums"]["bank_account_lifecycle_status"]
          name: string
          opening_balance: number
          opening_balance_date: string | null
          opening_balance_je_id: string | null
          organization_id: string
          provider_id: string | null
          refresh_token_encrypted: string | null
          routing_number: string | null
          row_version: number
          sync_frequency: string | null
          sync_from_date: string | null
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token_encrypted?: string | null
          account_id?: string | null
          account_number?: string | null
          account_type?: string | null
          activated_at?: string | null
          auto_sync_enabled?: boolean | null
          bank_balance_as_of?: string | null
          bank_name?: string | null
          bank_reported_balance?: number | null
          branch_id?: string | null
          business_id?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          currency?: string
          current_balance?: number | null
          external_account_id?: string | null
          id?: string
          is_active?: boolean
          is_primary?: boolean | null
          is_shared?: boolean
          last_auto_sync_at?: string | null
          lifecycle_status?: Database["public"]["Enums"]["bank_account_lifecycle_status"]
          name: string
          opening_balance?: number
          opening_balance_date?: string | null
          opening_balance_je_id?: string | null
          organization_id: string
          provider_id?: string | null
          refresh_token_encrypted?: string | null
          routing_number?: string | null
          row_version?: number
          sync_frequency?: string | null
          sync_from_date?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token_encrypted?: string | null
          account_id?: string | null
          account_number?: string | null
          account_type?: string | null
          activated_at?: string | null
          auto_sync_enabled?: boolean | null
          bank_balance_as_of?: string | null
          bank_name?: string | null
          bank_reported_balance?: number | null
          branch_id?: string | null
          business_id?: string | null
          closed_at?: string | null
          closed_reason?: string | null
          created_at?: string
          currency?: string
          current_balance?: number | null
          external_account_id?: string | null
          id?: string
          is_active?: boolean
          is_primary?: boolean | null
          is_shared?: boolean
          last_auto_sync_at?: string | null
          lifecycle_status?: Database["public"]["Enums"]["bank_account_lifecycle_status"]
          name?: string
          opening_balance?: number
          opening_balance_date?: string | null
          opening_balance_je_id?: string | null
          organization_id?: string
          provider_id?: string | null
          refresh_token_encrypted?: string | null
          routing_number?: string | null
          row_version?: number
          sync_frequency?: string | null
          sync_from_date?: string | null
          token_expires_at?: string | null
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
            foreignKeyName: "bank_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_opening_balance_je_id_fkey"
            columns: ["opening_balance_je_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "bank_accounts_opening_balance_je_id_fkey"
            columns: ["opening_balance_je_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_opening_balance_je_id_fkey"
            columns: ["opening_balance_je_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bank_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
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
      bank_feed_connections: {
        Row: {
          auto_sync_enabled: boolean
          bank_account_id: string
          business_id: string
          config: Json
          consecutive_failures: number
          created_at: string
          created_by: string | null
          external_account_id: string | null
          id: string
          last_error: string | null
          last_run_at: string | null
          last_success_at: string | null
          organization_id: string
          provider_code: string
          provider_id: string | null
          status: string
          sync_frequency: string
          sync_from_date: string | null
          updated_at: string
        }
        Insert: {
          auto_sync_enabled?: boolean
          bank_account_id: string
          business_id: string
          config?: Json
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          organization_id: string
          provider_code: string
          provider_id?: string | null
          status?: string
          sync_frequency?: string
          sync_from_date?: string | null
          updated_at?: string
        }
        Update: {
          auto_sync_enabled?: boolean
          bank_account_id?: string
          business_id?: string
          config?: Json
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          external_account_id?: string | null
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          last_success_at?: string | null
          organization_id?: string
          provider_code?: string
          provider_id?: string | null
          status?: string
          sync_frequency?: string
          sync_from_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_feed_connections_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_feed_connections_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_reconciliation_items: {
        Row: {
          branch_id: string | null
          cleared_at: string | null
          cleared_by: string | null
          created_at: string
          id: string
          is_sample_data: boolean
          session_id: string
          status: string
          transaction_id: string
        }
        Insert: {
          branch_id?: string | null
          cleared_at?: string | null
          cleared_by?: string | null
          created_at?: string
          id?: string
          is_sample_data?: boolean
          session_id: string
          status?: string
          transaction_id: string
        }
        Update: {
          branch_id?: string | null
          cleared_at?: string | null
          cleared_by?: string | null
          created_at?: string
          id?: string
          is_sample_data?: boolean
          session_id?: string
          status?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_reconciliation_items_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_items_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "bank_reconciliation_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_items_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_reconciliation_matches: {
        Row: {
          adjustment_journal_entry_id: string | null
          allocations: Json
          bank_transaction_id: string
          branch_id: string | null
          business_id: string
          confidence: number
          confirmed_at: string | null
          confirmed_by: string | null
          created_at: string
          created_by: string | null
          evidence: Json | null
          exchange_rate: number | null
          fee_account_id: string | null
          fee_amount: number
          fee_journal_entry_id: string | null
          id: string
          legal_order_remittance_batch_id: string | null
          match_type: string
          matched_amount: number
          matched_entity_id: string | null
          matched_entity_type: string | null
          matched_journal_entry_id: string | null
          matched_payment_id: string | null
          notes: string | null
          organization_id: string
          proposed_by: string | null
          rejected_at: string | null
          rejected_by: string | null
          residual_amount: number
          reversed_at: string | null
          reversed_by: string | null
          rule_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          adjustment_journal_entry_id?: string | null
          allocations?: Json
          bank_transaction_id: string
          branch_id?: string | null
          business_id: string
          confidence?: number
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: Json | null
          exchange_rate?: number | null
          fee_account_id?: string | null
          fee_amount?: number
          fee_journal_entry_id?: string | null
          id?: string
          legal_order_remittance_batch_id?: string | null
          match_type?: string
          matched_amount?: number
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          matched_journal_entry_id?: string | null
          matched_payment_id?: string | null
          notes?: string | null
          organization_id: string
          proposed_by?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          residual_amount?: number
          reversed_at?: string | null
          reversed_by?: string | null
          rule_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          adjustment_journal_entry_id?: string | null
          allocations?: Json
          bank_transaction_id?: string
          branch_id?: string | null
          business_id?: string
          confidence?: number
          confirmed_at?: string | null
          confirmed_by?: string | null
          created_at?: string
          created_by?: string | null
          evidence?: Json | null
          exchange_rate?: number | null
          fee_account_id?: string | null
          fee_amount?: number
          fee_journal_entry_id?: string | null
          id?: string
          legal_order_remittance_batch_id?: string | null
          match_type?: string
          matched_amount?: number
          matched_entity_id?: string | null
          matched_entity_type?: string | null
          matched_journal_entry_id?: string | null
          matched_payment_id?: string | null
          notes?: string | null
          organization_id?: string
          proposed_by?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          residual_amount?: number
          reversed_at?: string | null
          reversed_by?: string | null
          rule_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_reconciliation_matches_bank_transaction_id_fkey"
            columns: ["bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_fee_account_id_fkey"
            columns: ["fee_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_fee_account_id_fkey"
            columns: ["fee_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_matched_journal_entry_id_fkey"
            columns: ["matched_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_matched_journal_entry_id_fkey"
            columns: ["matched_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_matched_journal_entry_id_fkey"
            columns: ["matched_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_matches_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "bank_reconciliation_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_reconciliation_rules: {
        Row: {
          amount_max: number | null
          amount_min: number | null
          amount_sign: string | null
          auto_post: boolean
          bank_account_id: string | null
          branch_id: string | null
          business_id: string
          counterpart_account_id: string
          counterpart_contact_id: string | null
          created_at: string
          created_by: string | null
          description_pattern: string | null
          description_regex: string | null
          description_template: string | null
          id: string
          is_active: boolean
          journal_book_id: string | null
          last_matched_at: string | null
          match_count: number
          name: string
          organization_id: string
          priority: number
          reference_pattern: string | null
          updated_at: string
        }
        Insert: {
          amount_max?: number | null
          amount_min?: number | null
          amount_sign?: string | null
          auto_post?: boolean
          bank_account_id?: string | null
          branch_id?: string | null
          business_id: string
          counterpart_account_id: string
          counterpart_contact_id?: string | null
          created_at?: string
          created_by?: string | null
          description_pattern?: string | null
          description_regex?: string | null
          description_template?: string | null
          id?: string
          is_active?: boolean
          journal_book_id?: string | null
          last_matched_at?: string | null
          match_count?: number
          name: string
          organization_id: string
          priority?: number
          reference_pattern?: string | null
          updated_at?: string
        }
        Update: {
          amount_max?: number | null
          amount_min?: number | null
          amount_sign?: string | null
          auto_post?: boolean
          bank_account_id?: string | null
          branch_id?: string | null
          business_id?: string
          counterpart_account_id?: string
          counterpart_contact_id?: string | null
          created_at?: string
          created_by?: string | null
          description_pattern?: string | null
          description_regex?: string | null
          description_template?: string | null
          id?: string
          is_active?: boolean
          journal_book_id?: string | null
          last_matched_at?: string | null
          match_count?: number
          name?: string
          organization_id?: string
          priority?: number
          reference_pattern?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_reconciliation_rules_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_counterpart_account_id_fkey"
            columns: ["counterpart_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_counterpart_account_id_fkey"
            columns: ["counterpart_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_counterpart_contact_id_fkey"
            columns: ["counterpart_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_journal_book_id_fkey"
            columns: ["journal_book_id"]
            isOneToOne: false
            referencedRelation: "journal_books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_reconciliation_sessions: {
        Row: {
          bank_account_id: string
          branch_id: string | null
          business_id: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          closing_balance: number
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          difference: number | null
          id: string
          interest_earned_account_id: string | null
          interest_earned_amount: number | null
          interest_earned_date: string | null
          is_sample_data: boolean
          notes: string | null
          opening_balance: number
          organization_id: string
          reconciled_balance: number
          service_charge_account_id: string | null
          service_charge_amount: number | null
          service_charge_date: string | null
          statement_date: string
          status: string
          updated_at: string
          writeoff_amount: number
          writeoff_je_id: string | null
        }
        Insert: {
          bank_account_id: string
          branch_id?: string | null
          business_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          closing_balance?: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          difference?: number | null
          id?: string
          interest_earned_account_id?: string | null
          interest_earned_amount?: number | null
          interest_earned_date?: string | null
          is_sample_data?: boolean
          notes?: string | null
          opening_balance?: number
          organization_id: string
          reconciled_balance?: number
          service_charge_account_id?: string | null
          service_charge_amount?: number | null
          service_charge_date?: string | null
          statement_date: string
          status?: string
          updated_at?: string
          writeoff_amount?: number
          writeoff_je_id?: string | null
        }
        Update: {
          bank_account_id?: string
          branch_id?: string | null
          business_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          closing_balance?: number
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          difference?: number | null
          id?: string
          interest_earned_account_id?: string | null
          interest_earned_amount?: number | null
          interest_earned_date?: string | null
          is_sample_data?: boolean
          notes?: string | null
          opening_balance?: number
          organization_id?: string
          reconciled_balance?: number
          service_charge_account_id?: string | null
          service_charge_amount?: number | null
          service_charge_date?: string | null
          statement_date?: string
          status?: string
          updated_at?: string
          writeoff_amount?: number
          writeoff_je_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_reconciliation_sessions_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_interest_earned_account_id_fkey"
            columns: ["interest_earned_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_interest_earned_account_id_fkey"
            columns: ["interest_earned_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_service_charge_account_id_fkey"
            columns: ["service_charge_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_sessions_service_charge_account_id_fkey"
            columns: ["service_charge_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_reconciliation_writeoffs: {
        Row: {
          account_id: string
          amount: number
          branch_id: string | null
          created_at: string
          id: string
          journal_entry_id: string | null
          reason: string
          reconciliation_match_id: string
          reversed_at: string | null
          reversed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_id: string
          amount: number
          branch_id?: string | null
          created_at?: string
          id?: string
          journal_entry_id?: string | null
          reason?: string
          reconciliation_match_id: string
          reversed_at?: string | null
          reversed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          amount?: number
          branch_id?: string | null
          created_at?: string
          id?: string
          journal_entry_id?: string | null
          reason?: string
          reconciliation_match_id?: string
          reversed_at?: string | null
          reversed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_reconciliation_writeoffs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_reconciliation_writeoffs_reconciliation_match_id_fkey"
            columns: ["reconciliation_match_id"]
            isOneToOne: false
            referencedRelation: "bank_reconciliation_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_transactions: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          ai_suggested_category: string | null
          amount: number
          balance_after: number | null
          bank_account_id: string
          branch_id: string | null
          business_id: string | null
          category: string | null
          category_confidence: number | null
          created_at: string | null
          description: string
          external_transaction_id: string
          id: string
          is_reconciled: boolean | null
          is_sample_data: boolean
          journal_entry_id: string | null
          lifecycle_status: string
          organization_id: string
          posting_date: string | null
          raw_data: Json | null
          reconciled_at: string | null
          reconciled_by: string | null
          reconciled_entity_id: string | null
          reconciled_payment_id: string | null
          reconciled_type: string | null
          reference: string | null
          transaction_date: string
          transaction_type: string
          updated_at: string | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_suggested_category?: string | null
          amount: number
          balance_after?: number | null
          bank_account_id: string
          branch_id?: string | null
          business_id?: string | null
          category?: string | null
          category_confidence?: number | null
          created_at?: string | null
          description: string
          external_transaction_id: string
          id?: string
          is_reconciled?: boolean | null
          is_sample_data?: boolean
          journal_entry_id?: string | null
          lifecycle_status?: string
          organization_id: string
          posting_date?: string | null
          raw_data?: Json | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          reconciled_entity_id?: string | null
          reconciled_payment_id?: string | null
          reconciled_type?: string | null
          reference?: string | null
          transaction_date: string
          transaction_type: string
          updated_at?: string | null
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_suggested_category?: string | null
          amount?: number
          balance_after?: number | null
          bank_account_id?: string
          branch_id?: string | null
          business_id?: string | null
          category?: string | null
          category_confidence?: number | null
          created_at?: string | null
          description?: string
          external_transaction_id?: string
          id?: string
          is_reconciled?: boolean | null
          is_sample_data?: boolean
          journal_entry_id?: string | null
          lifecycle_status?: string
          organization_id?: string
          posting_date?: string | null
          raw_data?: Json | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          reconciled_entity_id?: string | null
          reconciled_payment_id?: string | null
          reconciled_type?: string | null
          reference?: string | null
          transaction_date?: string
          transaction_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "bank_transactions_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bank_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "bank_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      branch_overridable_settings: {
        Row: {
          category: string
          created_at: string
          description: string | null
          display_name: string
          setting_key: string
          value_type: string
        }
        Insert: {
          category: string
          created_at?: string
          description?: string | null
          display_name: string
          setting_key: string
          value_type: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          display_name?: string
          setting_key?: string
          value_type?: string
        }
        Relationships: []
      }
      branch_setting_overrides: {
        Row: {
          branch_id: string
          business_id: string
          created_at: string
          id: string
          organization_id: string
          reason: string | null
          set_by: string | null
          setting_key: string
          setting_value: Json
          updated_at: string
        }
        Insert: {
          branch_id: string
          business_id: string
          created_at?: string
          id?: string
          organization_id: string
          reason?: string | null
          set_by?: string | null
          setting_key: string
          setting_value: Json
          updated_at?: string
        }
        Update: {
          branch_id?: string
          business_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          reason?: string | null
          set_by?: string | null
          setting_key?: string
          setting_value?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "branch_setting_overrides_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_setting_overrides_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_setting_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "branch_setting_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "branch_setting_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "branch_setting_overrides_setting_key_fkey"
            columns: ["setting_key"]
            isOneToOne: false
            referencedRelation: "branch_overridable_settings"
            referencedColumns: ["setting_key"]
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
          email: string | null
          id: string
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
          email?: string | null
          id?: string
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
          email?: string | null
          id?: string
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "branches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
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
      budget_items: {
        Row: {
          account_id: string
          analytic_account_id: string | null
          budget_id: string
          budgeted_amount: number
          business_id: string | null
          created_at: string
          fiscal_period_id: string | null
          id: string
          notes: string | null
          period_month: number
          updated_at: string
        }
        Insert: {
          account_id: string
          analytic_account_id?: string | null
          budget_id: string
          budgeted_amount?: number
          business_id?: string | null
          created_at?: string
          fiscal_period_id?: string | null
          id?: string
          notes?: string | null
          period_month: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          analytic_account_id?: string | null
          budget_id?: string
          budgeted_amount?: number
          business_id?: string | null
          created_at?: string
          fiscal_period_id?: string | null
          id?: string
          notes?: string | null
          period_month?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_items_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_analytic_account_id_fkey"
            columns: ["analytic_account_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_items_fiscal_period_id_fkey"
            columns: ["fiscal_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_revision_lines: {
        Row: {
          account_id: string
          created_at: string
          fiscal_period_id: string
          id: string
          new_amount: number
          period_month: number
          previous_amount: number
          revision_id: string
        }
        Insert: {
          account_id: string
          created_at?: string
          fiscal_period_id: string
          id?: string
          new_amount?: number
          period_month: number
          previous_amount?: number
          revision_id: string
        }
        Update: {
          account_id?: string
          created_at?: string
          fiscal_period_id?: string
          id?: string
          new_amount?: number
          period_month?: number
          previous_amount?: number
          revision_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "budget_revision_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_revision_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_revision_lines_fiscal_period_id_fkey"
            columns: ["fiscal_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_revision_lines_revision_id_fkey"
            columns: ["revision_id"]
            isOneToOne: false
            referencedRelation: "budget_revisions"
            referencedColumns: ["id"]
          },
        ]
      }
      budget_revisions: {
        Row: {
          budget_id: string
          business_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          organization_id: string
          reason: string
          revision_number: number
        }
        Insert: {
          budget_id: string
          business_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          organization_id: string
          reason: string
          revision_number: number
        }
        Update: {
          budget_id?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          organization_id?: string
          reason?: string
          revision_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "budget_revisions_budget_id_fkey"
            columns: ["budget_id"]
            isOneToOne: false
            referencedRelation: "budgets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_revisions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budget_revisions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "budget_revisions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "budget_revisions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      budgets: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string | null
          budget_code: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string | null
          description: string | null
          fiscal_year: number
          id: string
          name: string
          organization_id: string
          status: Database["public"]["Enums"]["budget_status"]
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string | null
          budget_code?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string | null
          description?: string | null
          fiscal_year: number
          id?: string
          name: string
          organization_id: string
          status?: Database["public"]["Enums"]["budget_status"]
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          branch_id?: string | null
          budget_code?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string | null
          description?: string | null
          fiscal_year?: number
          id?: string
          name?: string
          organization_id?: string
          status?: Database["public"]["Enums"]["budget_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "budgets_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "budgets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "budgets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "budgets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_operation_row_results: {
        Row: {
          apply_error: string | null
          apply_status: string
          created_at: string
          id: string
          normalized_payload: Json
          raw_payload: Json
          row_index: number
          run_id: string
          target_id: string | null
          target_table: string | null
          validation_errors: Json
        }
        Insert: {
          apply_error?: string | null
          apply_status?: string
          created_at?: string
          id?: string
          normalized_payload?: Json
          raw_payload?: Json
          row_index: number
          run_id: string
          target_id?: string | null
          target_table?: string | null
          validation_errors?: Json
        }
        Update: {
          apply_error?: string | null
          apply_status?: string
          created_at?: string
          id?: string
          normalized_payload?: Json
          raw_payload?: Json
          row_index?: number
          run_id?: string
          target_id?: string | null
          target_table?: string | null
          validation_errors?: Json
        }
        Relationships: [
          {
            foreignKeyName: "bulk_operation_row_results_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "bulk_operation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_operation_runs: {
        Row: {
          actor_user_id: string | null
          applied_at: string | null
          business_id: string | null
          created_at: string
          error_message: string | null
          id: string
          kind: Database["public"]["Enums"]["bulk_operation_kind"]
          organization_id: string
          params: Json
          rows_applied: number
          rows_failed: number
          rows_invalid: number
          rows_total: number
          rows_valid: number
          schema_snapshot: Json
          source_filename: string | null
          source_storage_path: string | null
          status: Database["public"]["Enums"]["bulk_operation_status"]
          submitted_at: string | null
          summary: Json
          updated_at: string
        }
        Insert: {
          actor_user_id?: string | null
          applied_at?: string | null
          business_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          kind: Database["public"]["Enums"]["bulk_operation_kind"]
          organization_id: string
          params?: Json
          rows_applied?: number
          rows_failed?: number
          rows_invalid?: number
          rows_total?: number
          rows_valid?: number
          schema_snapshot?: Json
          source_filename?: string | null
          source_storage_path?: string | null
          status?: Database["public"]["Enums"]["bulk_operation_status"]
          submitted_at?: string | null
          summary?: Json
          updated_at?: string
        }
        Update: {
          actor_user_id?: string | null
          applied_at?: string | null
          business_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["bulk_operation_kind"]
          organization_id?: string
          params?: Json
          rows_applied?: number
          rows_failed?: number
          rows_invalid?: number
          rows_total?: number
          rows_valid?: number
          schema_snapshot?: Json
          source_filename?: string | null
          source_storage_path?: string | null
          status?: Database["public"]["Enums"]["bulk_operation_status"]
          submitted_at?: string | null
          summary?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bulk_operation_runs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_operation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bulk_operation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "bulk_operation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_active_currencies: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          currency_code: string
          id: string
          is_enabled: boolean
          organization_id: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          currency_code: string
          id?: string
          is_enabled?: boolean
          organization_id: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          id?: string
          is_enabled?: boolean
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_active_currencies_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_active_currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "business_active_currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "business_active_currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_currency_change_audit: {
        Row: {
          actor_id: string
          business_id: string
          created_at: string
          draft_counts: Json
          id: string
          impact_snapshot: Json
          new_currency: string
          old_currency: string
          organization_id: string
          reason: string
        }
        Insert: {
          actor_id: string
          business_id: string
          created_at?: string
          draft_counts?: Json
          id?: string
          impact_snapshot?: Json
          new_currency: string
          old_currency: string
          organization_id: string
          reason: string
        }
        Update: {
          actor_id?: string
          business_id?: string
          created_at?: string
          draft_counts?: Json
          id?: string
          impact_snapshot?: Json
          new_currency?: string
          old_currency?: string
          organization_id?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_currency_change_audit_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_currency_change_audit_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "business_currency_change_audit_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "business_currency_change_audit_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_event_outbox: {
        Row: {
          actor_user_id: string | null
          attempts: number
          branch_id: string | null
          claim_lease_seconds: number
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          event_type: string
          handler_scope: string
          id: string
          idempotency_key: string
          last_error: string | null
          org_id: string
          payload: Json
          source: string
          source_doc_id: string
          source_doc_type: string
          status: Database["public"]["Enums"]["business_event_status"]
          updated_at: string
          warehouse_id: string | null
          worker_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          attempts?: number
          branch_id?: string | null
          claim_lease_seconds?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          event_type: string
          handler_scope?: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          org_id: string
          payload?: Json
          source?: string
          source_doc_id: string
          source_doc_type: string
          status?: Database["public"]["Enums"]["business_event_status"]
          updated_at?: string
          warehouse_id?: string | null
          worker_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          attempts?: number
          branch_id?: string | null
          claim_lease_seconds?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          event_type?: string
          handler_scope?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          org_id?: string
          payload?: Json
          source?: string
          source_doc_id?: string
          source_doc_type?: string
          status?: Database["public"]["Enums"]["business_event_status"]
          updated_at?: string
          warehouse_id?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      business_event_outbox_dead: {
        Row: {
          actor_user_id: string | null
          attempts: number
          branch_id: string | null
          dead_at: string
          dead_reason: string
          event_type: string
          first_attempt_at: string | null
          id: string
          idempotency_key: string | null
          last_error: string | null
          org_id: string
          original_created_at: string | null
          payload: Json | null
          source: string | null
          source_doc_id: string
          source_doc_type: string
          warehouse_id: string | null
          worker_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          attempts?: number
          branch_id?: string | null
          dead_at?: string
          dead_reason: string
          event_type: string
          first_attempt_at?: string | null
          id: string
          idempotency_key?: string | null
          last_error?: string | null
          org_id: string
          original_created_at?: string | null
          payload?: Json | null
          source?: string | null
          source_doc_id: string
          source_doc_type: string
          warehouse_id?: string | null
          worker_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          attempts?: number
          branch_id?: string | null
          dead_at?: string
          dead_reason?: string
          event_type?: string
          first_attempt_at?: string | null
          id?: string
          idempotency_key?: string | null
          last_error?: string | null
          org_id?: string
          original_created_at?: string | null
          payload?: Json | null
          source?: string | null
          source_doc_id?: string
          source_doc_type?: string
          warehouse_id?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      business_event_subscriptions: {
        Row: {
          consumer_domain: string
          created_at: string
          event_type: string
          handler_function: string
          id: string
          is_active: boolean
          subscriber_name: string
          updated_at: string
        }
        Insert: {
          consumer_domain: string
          created_at?: string
          event_type: string
          handler_function: string
          id?: string
          is_active?: boolean
          subscriber_name: string
          updated_at?: string
        }
        Update: {
          consumer_domain?: string
          created_at?: string
          event_type?: string
          handler_function?: string
          id?: string
          is_active?: boolean
          subscriber_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      business_event_topics: {
        Row: {
          consumer_domains: string[]
          created_at: string
          description: string | null
          handler_scope: string
          integration_only: boolean
          max_attempts: number | null
          producer_domain: string
          topic_prefix: string
          updated_at: string
        }
        Insert: {
          consumer_domains?: string[]
          created_at?: string
          description?: string | null
          handler_scope?: string
          integration_only?: boolean
          max_attempts?: number | null
          producer_domain: string
          topic_prefix: string
          updated_at?: string
        }
        Update: {
          consumer_domains?: string[]
          created_at?: string
          description?: string | null
          handler_scope?: string
          integration_only?: boolean
          max_attempts?: number | null
          producer_domain?: string
          topic_prefix?: string
          updated_at?: string
        }
        Relationships: []
      }
      businesses: {
        Row: {
          address: string | null
          archived_at: string | null
          base_currency: string
          business_type: string | null
          city: string | null
          cost_model: string
          country: string
          created_at: string
          date_format: string | null
          default_tax_rate_id: string | null
          email: string | null
          email_display_name: string | null
          email_reply_to: string | null
          finance_readiness: string
          finance_readiness_checked_at: string | null
          finance_readiness_reason: string | null
          fiscal_year_start: number | null
          id: string
          industry: string | null
          is_active: boolean | null
          legal_name: string | null
          logo_url: string | null
          name: string
          number_format: string | null
          organization_id: string
          phone: string | null
          postal_code: string | null
          receipt_engine_v2: boolean
          receipt_settings: Json
          receipt_theme: Json | null
          registration_number: string | null
          require_product_physical_attributes: boolean
          sample_data_prompt_dismissed: boolean | null
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
          business_type?: string | null
          city?: string | null
          cost_model?: string
          country?: string
          created_at?: string
          date_format?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          email_display_name?: string | null
          email_reply_to?: string | null
          finance_readiness?: string
          finance_readiness_checked_at?: string | null
          finance_readiness_reason?: string | null
          fiscal_year_start?: number | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          legal_name?: string | null
          logo_url?: string | null
          name: string
          number_format?: string | null
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          receipt_engine_v2?: boolean
          receipt_settings?: Json
          receipt_theme?: Json | null
          registration_number?: string | null
          require_product_physical_attributes?: boolean
          sample_data_prompt_dismissed?: boolean | null
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
          business_type?: string | null
          city?: string | null
          cost_model?: string
          country?: string
          created_at?: string
          date_format?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          email_display_name?: string | null
          email_reply_to?: string | null
          finance_readiness?: string
          finance_readiness_checked_at?: string | null
          finance_readiness_reason?: string | null
          fiscal_year_start?: number | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          legal_name?: string | null
          logo_url?: string | null
          name?: string
          number_format?: string | null
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          receipt_engine_v2?: boolean
          receipt_settings?: Json
          receipt_theme?: Json | null
          registration_number?: string | null
          require_product_physical_attributes?: boolean
          sample_data_prompt_dismissed?: boolean | null
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "businesses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "businesses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      collector_assignments: {
        Row: {
          active: boolean
          assigned_at: string
          assigned_by: string | null
          business_id: string | null
          collector_user_id: string
          contact_id: string
          created_at: string
          deactivated_at: string | null
          deactivated_by: string | null
          id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          assigned_at?: string
          assigned_by?: string | null
          business_id?: string | null
          collector_user_id: string
          contact_id: string
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          id?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          assigned_at?: string
          assigned_by?: string | null
          business_id?: string | null
          collector_user_id?: string
          contact_id?: string
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collector_assignments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collector_assignments_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collector_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "collector_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "collector_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      commercial_audit_logs: {
        Row: {
          actor_id: string | null
          app_id: string | null
          created_at: string
          event_type: string
          id: string
          org_id: string
          payload: Json
          plan_id: string | null
        }
        Insert: {
          actor_id?: string | null
          app_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          org_id: string
          payload?: Json
          plan_id?: string | null
        }
        Update: {
          actor_id?: string | null
          app_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          org_id?: string
          payload?: Json
          plan_id?: string | null
        }
        Relationships: []
      }
      compliance_checklist: {
        Row: {
          assigned_to: string | null
          attachments: Json | null
          business_id: string | null
          category: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          description: string | null
          due_date: string | null
          frequency: string | null
          id: string
          last_reminded_at: string | null
          notes: string | null
          organization_id: string
          reminder_days: number | null
          status: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          attachments?: Json | null
          business_id?: string | null
          category: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          frequency?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          organization_id: string
          reminder_days?: number | null
          status?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          attachments?: Json | null
          business_id?: string | null
          category?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          frequency?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          organization_id?: string
          reminder_days?: number | null
          status?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_checklist_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_checklist_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "compliance_checklist_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "compliance_checklist_organization_id_fkey"
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
          business_id: string | null
          child_address_type: string | null
          city: string | null
          commercial_partner_id: string | null
          company: string | null
          country: string | null
          created_at: string
          credit_hold: boolean | null
          credit_limit: number | null
          customer_rank: number
          default_currency: string | null
          default_expense_account_id: string | null
          default_payable_account_id: string | null
          default_payment_method_id: string | null
          default_receivable_account_id: string | null
          default_tax_rate_id: string | null
          email: string | null
          id: string
          is_active: boolean
          is_company: boolean
          is_default_billing: boolean
          is_default_shipping: boolean
          is_pinned: boolean | null
          is_sample_data: boolean
          name: string
          notes: string | null
          opening_balance: number | null
          opening_balance_date: string | null
          organization_id: string
          parent_contact_id: string | null
          payment_term_id: string | null
          phone: string | null
          portal_user_id: string | null
          postal_code: string | null
          sms_consent: boolean | null
          state: string | null
          supplier_rank: number
          tax_exemption_expiry: string | null
          tax_exemption_number: string | null
          tax_id: string | null
          type: Database["public"]["Enums"]["contact_type"] | null
          updated_at: string
          withholding_tax_rate: number | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          business_id?: string | null
          child_address_type?: string | null
          city?: string | null
          commercial_partner_id?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          credit_hold?: boolean | null
          credit_limit?: number | null
          customer_rank?: number
          default_currency?: string | null
          default_expense_account_id?: string | null
          default_payable_account_id?: string | null
          default_payment_method_id?: string | null
          default_receivable_account_id?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_company?: boolean
          is_default_billing?: boolean
          is_default_shipping?: boolean
          is_pinned?: boolean | null
          is_sample_data?: boolean
          name: string
          notes?: string | null
          opening_balance?: number | null
          opening_balance_date?: string | null
          organization_id: string
          parent_contact_id?: string | null
          payment_term_id?: string | null
          phone?: string | null
          portal_user_id?: string | null
          postal_code?: string | null
          sms_consent?: boolean | null
          state?: string | null
          supplier_rank?: number
          tax_exemption_expiry?: string | null
          tax_exemption_number?: string | null
          tax_id?: string | null
          type?: Database["public"]["Enums"]["contact_type"] | null
          updated_at?: string
          withholding_tax_rate?: number | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          business_id?: string | null
          child_address_type?: string | null
          city?: string | null
          commercial_partner_id?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          credit_hold?: boolean | null
          credit_limit?: number | null
          customer_rank?: number
          default_currency?: string | null
          default_expense_account_id?: string | null
          default_payable_account_id?: string | null
          default_payment_method_id?: string | null
          default_receivable_account_id?: string | null
          default_tax_rate_id?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          is_company?: boolean
          is_default_billing?: boolean
          is_default_shipping?: boolean
          is_pinned?: boolean | null
          is_sample_data?: boolean
          name?: string
          notes?: string | null
          opening_balance?: number | null
          opening_balance_date?: string | null
          organization_id?: string
          parent_contact_id?: string | null
          payment_term_id?: string | null
          phone?: string | null
          portal_user_id?: string | null
          postal_code?: string | null
          sms_consent?: boolean | null
          state?: string | null
          supplier_rank?: number
          tax_exemption_expiry?: string | null
          tax_exemption_number?: string | null
          tax_id?: string | null
          type?: Database["public"]["Enums"]["contact_type"] | null
          updated_at?: string
          withholding_tax_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_commercial_partner_id_fkey"
            columns: ["commercial_partner_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_expense_account_id_fkey"
            columns: ["default_expense_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_expense_account_id_fkey"
            columns: ["default_expense_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_payable_account_id_fkey"
            columns: ["default_payable_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_payable_account_id_fkey"
            columns: ["default_payable_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_payment_method_id_fkey"
            columns: ["default_payment_method_id"]
            isOneToOne: false
            referencedRelation: "organization_payment_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_receivable_account_id_fkey"
            columns: ["default_receivable_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_receivable_account_id_fkey"
            columns: ["default_receivable_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_default_tax_rate_id_fkey"
            columns: ["default_tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_parent_contact_id_fkey"
            columns: ["parent_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_payment_term_id_fkey"
            columns: ["payment_term_id"]
            isOneToOne: false
            referencedRelation: "payment_terms"
            referencedColumns: ["id"]
          },
        ]
      }
      control_account_drift_log: {
        Row: {
          account_code: string | null
          account_id: string
          account_name: string | null
          created_at: string
          drift: number
          gl_balance: number
          id: string
          organization_id: string
          snapshot_at: string
          subledger_balance: number
          system_role: string | null
        }
        Insert: {
          account_code?: string | null
          account_id: string
          account_name?: string | null
          created_at?: string
          drift: number
          gl_balance: number
          id?: string
          organization_id: string
          snapshot_at?: string
          subledger_balance: number
          system_role?: string | null
        }
        Update: {
          account_code?: string | null
          account_id?: string
          account_name?: string | null
          created_at?: string
          drift?: number
          gl_balance?: number
          id?: string
          organization_id?: string
          snapshot_at?: string
          subledger_balance?: number
          system_role?: string | null
        }
        Relationships: []
      }
      core_field_overrides: {
        Row: {
          created_at: string
          display_order: number | null
          entity_type: string
          field_key: string
          id: string
          is_visible: boolean
          label_override: string | null
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_order?: number | null
          entity_type: string
          field_key: string
          id?: string
          is_visible?: boolean
          label_override?: string | null
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_order?: number | null
          entity_type?: string
          field_key?: string
          id?: string
          is_visible?: boolean
          label_override?: string | null
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "core_field_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "core_field_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "core_field_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      countries: {
        Row: {
          code: string
          created_at: string
          default_currency: string | null
          id: string
          is_active: boolean
          name: string
          official_name: string | null
          phone_code: string | null
          region: string | null
        }
        Insert: {
          code: string
          created_at?: string
          default_currency?: string | null
          id?: string
          is_active?: boolean
          name: string
          official_name?: string | null
          phone_code?: string | null
          region?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          default_currency?: string | null
          id?: string
          is_active?: boolean
          name?: string
          official_name?: string | null
          phone_code?: string | null
          region?: string | null
        }
        Relationships: []
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "currencies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      default_account_mapping_audit: {
        Row: {
          action: string
          batch_id: string | null
          business_id: string | null
          confidence: string | null
          created_at: string
          id: string
          new_account_id: string | null
          organization_id: string
          performed_by: string | null
          previous_account_id: string | null
          reason: string | null
          role_key: string
          score: number | null
        }
        Insert: {
          action: string
          batch_id?: string | null
          business_id?: string | null
          confidence?: string | null
          created_at?: string
          id?: string
          new_account_id?: string | null
          organization_id: string
          performed_by?: string | null
          previous_account_id?: string | null
          reason?: string | null
          role_key: string
          score?: number | null
        }
        Update: {
          action?: string
          batch_id?: string | null
          business_id?: string | null
          confidence?: string | null
          created_at?: string
          id?: string
          new_account_id?: string | null
          organization_id?: string
          performed_by?: string | null
          previous_account_id?: string | null
          reason?: string | null
          role_key?: string
          score?: number | null
        }
        Relationships: []
      }
      default_account_mappings: {
        Row: {
          account_id: string
          business_id: string | null
          created_at: string
          id: string
          is_default: boolean | null
          mapping_type: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          account_id: string
          business_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean | null
          mapping_type: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          business_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean | null
          mapping_type?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "default_account_mappings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_mappings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_mappings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "default_account_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "default_account_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      default_account_setting_bindings: {
        Row: {
          account_id: string
          branch_id: string | null
          business_id: string | null
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          organization_id: string
          origin_pack_id: string | null
          origin_pack_version: string | null
          overridden_by: string | null
          override_reason: string | null
          setting_key: string
          source: string
        }
        Insert: {
          account_id: string
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          organization_id: string
          origin_pack_id?: string | null
          origin_pack_version?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          setting_key: string
          source?: string
        }
        Update: {
          account_id?: string
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          organization_id?: string
          origin_pack_id?: string | null
          origin_pack_version?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          setting_key?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "default_account_setting_bindings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_setting_bindings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_setting_bindings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "default_account_setting_bindings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "default_account_setting_bindings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      default_account_settings: {
        Row: {
          account_id: string
          branch_id: string | null
          business_id: string
          created_at: string
          id: string
          organization_id: string
          origin_pack_id: string | null
          origin_pack_version: string | null
          overridden_at: string | null
          overridden_by: string | null
          override_reason: string | null
          setting_key: string
          source: string
          updated_at: string
        }
        Insert: {
          account_id: string
          branch_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          organization_id: string
          origin_pack_id?: string | null
          origin_pack_version?: string | null
          overridden_at?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          setting_key: string
          source?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          branch_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          origin_pack_id?: string | null
          origin_pack_version?: string | null
          overridden_at?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          setting_key?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "default_account_settings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_settings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_settings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_account_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "default_account_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "default_account_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      default_accounts: {
        Row: {
          account_id: string
          branch_id: string | null
          business_id: string
          created_at: string
          id: string
          organization_id: string
          purpose: string
          updated_at: string
        }
        Insert: {
          account_id: string
          branch_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          organization_id: string
          purpose: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          branch_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          purpose?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "default_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_accounts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "default_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "default_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "default_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      default_chart_of_accounts: {
        Row: {
          account_code: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          country_code: string
          created_at: string | null
          description: string | null
          detail_type: string | null
          id: string
          is_country_neutral: boolean
          is_system: boolean | null
          parent_code: string | null
          role_key: string | null
        }
        Insert: {
          account_code: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          country_code: string
          created_at?: string | null
          description?: string | null
          detail_type?: string | null
          id?: string
          is_country_neutral?: boolean
          is_system?: boolean | null
          parent_code?: string | null
          role_key?: string | null
        }
        Update: {
          account_code?: string
          account_name?: string
          account_type?: Database["public"]["Enums"]["account_type"]
          country_code?: string
          created_at?: string | null
          description?: string | null
          detail_type?: string | null
          id?: string
          is_country_neutral?: boolean
          is_system?: boolean | null
          parent_code?: string | null
          role_key?: string | null
        }
        Relationships: []
      }
      departments: {
        Row: {
          archived_at: string | null
          archived_by: string | null
          branch_id: string | null
          business_id: string
          code: string | null
          created_at: string | null
          description: string | null
          dissolved_at: string | null
          dissolved_by: string | null
          id: string
          is_active: boolean | null
          manager_id: string | null
          name: string
          organization_id: string
          parent_department_id: string | null
          status: Database["public"]["Enums"]["department_status"]
          updated_at: string | null
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          branch_id?: string | null
          business_id: string
          code?: string | null
          created_at?: string | null
          description?: string | null
          dissolved_at?: string | null
          dissolved_by?: string | null
          id?: string
          is_active?: boolean | null
          manager_id?: string | null
          name: string
          organization_id: string
          parent_department_id?: string | null
          status?: Database["public"]["Enums"]["department_status"]
          updated_at?: string | null
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          branch_id?: string | null
          business_id?: string
          code?: string | null
          created_at?: string | null
          description?: string | null
          dissolved_at?: string | null
          dissolved_by?: string | null
          id?: string
          is_active?: boolean | null
          manager_id?: string | null
          name?: string
          organization_id?: string
          parent_department_id?: string | null
          status?: Database["public"]["Enums"]["department_status"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "departments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_parent_department_id_fkey"
            columns: ["parent_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      depreciation_entries: {
        Row: {
          accumulated_depreciation: number
          asset_id: string
          book_value: number
          branch_id: string | null
          business_id: string
          created_at: string
          depreciation_amount: number
          id: string
          is_posted: boolean | null
          journal_entry_id: string | null
          organization_id: string
          period_end: string
          period_start: string
        }
        Insert: {
          accumulated_depreciation: number
          asset_id: string
          book_value: number
          branch_id?: string | null
          business_id: string
          created_at?: string
          depreciation_amount: number
          id?: string
          is_posted?: boolean | null
          journal_entry_id?: string | null
          organization_id: string
          period_end: string
          period_start: string
        }
        Update: {
          accumulated_depreciation?: number
          asset_id?: string
          book_value?: number
          branch_id?: string | null
          business_id?: string
          created_at?: string
          depreciation_amount?: number
          id?: string
          is_posted?: boolean | null
          journal_entry_id?: string | null
          organization_id?: string
          period_end?: string
          period_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "depreciation_entries_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "fixed_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_entries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_entries_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "depreciation_entries_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_entries_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "depreciation_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "depreciation_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      depreciation_schedules: {
        Row: {
          accumulated_depreciation: number
          asset_id: string
          book_value: number
          branch_id: string | null
          business_id: string
          created_at: string | null
          depreciation_amount: number
          id: string
          is_posted: boolean | null
          journal_entry_id: string | null
          organization_id: string
          period_end: string
          period_start: string
          posted_at: string | null
          posted_by: string | null
        }
        Insert: {
          accumulated_depreciation: number
          asset_id: string
          book_value: number
          branch_id?: string | null
          business_id: string
          created_at?: string | null
          depreciation_amount: number
          id?: string
          is_posted?: boolean | null
          journal_entry_id?: string | null
          organization_id: string
          period_end: string
          period_start: string
          posted_at?: string | null
          posted_by?: string | null
        }
        Update: {
          accumulated_depreciation?: number
          asset_id?: string
          book_value?: number
          branch_id?: string | null
          business_id?: string
          created_at?: string | null
          depreciation_amount?: number
          id?: string
          is_posted?: boolean | null
          journal_entry_id?: string | null
          organization_id?: string
          period_end?: string
          period_start?: string
          posted_at?: string | null
          posted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "depreciation_schedules_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "fixed_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_schedules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_schedules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_schedules_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "depreciation_schedules_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_schedules_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_schedules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "depreciation_schedules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "depreciation_schedules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_artifacts: {
        Row: {
          branch_id: string | null
          business_id: string | null
          byte_size: number | null
          content_hash: string | null
          content_sha256: string | null
          copies: number | null
          created_at: string
          document_id: string | null
          document_number: string | null
          document_record_id: string | null
          document_type: string
          format: string | null
          id: string
          intent: string | null
          media_class: string | null
          metadata: Json
          mime_type: string | null
          organization_id: string
          page_count: number | null
          paper_format: string | null
          policy_id: string | null
          regeneration_reason: string | null
          render_mode: string | null
          rendered_by: string | null
          rendered_via: string | null
          retention_class: string
          storage_bucket: string
          storage_path: string
          superseded_by: string | null
          supersedes_id: string | null
          template_id: string | null
          template_version: number | null
          version: number
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          byte_size?: number | null
          content_hash?: string | null
          content_sha256?: string | null
          copies?: number | null
          created_at?: string
          document_id?: string | null
          document_number?: string | null
          document_record_id?: string | null
          document_type: string
          format?: string | null
          id?: string
          intent?: string | null
          media_class?: string | null
          metadata?: Json
          mime_type?: string | null
          organization_id: string
          page_count?: number | null
          paper_format?: string | null
          policy_id?: string | null
          regeneration_reason?: string | null
          render_mode?: string | null
          rendered_by?: string | null
          rendered_via?: string | null
          retention_class?: string
          storage_bucket: string
          storage_path: string
          superseded_by?: string | null
          supersedes_id?: string | null
          template_id?: string | null
          template_version?: number | null
          version?: number
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          byte_size?: number | null
          content_hash?: string | null
          content_sha256?: string | null
          copies?: number | null
          created_at?: string
          document_id?: string | null
          document_number?: string | null
          document_record_id?: string | null
          document_type?: string
          format?: string | null
          id?: string
          intent?: string | null
          media_class?: string | null
          metadata?: Json
          mime_type?: string | null
          organization_id?: string
          page_count?: number | null
          paper_format?: string | null
          policy_id?: string | null
          regeneration_reason?: string | null
          render_mode?: string | null
          rendered_by?: string | null
          rendered_via?: string | null
          retention_class?: string
          storage_bucket?: string
          storage_path?: string
          superseded_by?: string | null
          supersedes_id?: string | null
          template_id?: string | null
          template_version?: number | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_artifacts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_document_record_id_fkey"
            columns: ["document_record_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "document_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_artifacts_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "document_artifacts"
            referencedColumns: ["id"]
          },
        ]
      }
      document_emails: {
        Row: {
          attachment_filename: string | null
          bcc_emails: string[] | null
          body: string | null
          business_id: string | null
          cc_emails: string[] | null
          created_at: string
          document_id: string
          document_record_id: string | null
          document_type: string
          error_message: string | null
          had_attachment: boolean | null
          id: string
          message: string | null
          organization_id: string
          pdf_file_size_bytes: number | null
          pdf_generated_at: string | null
          pdf_storage_path: string | null
          provider_message_id: string | null
          recipient_email: string
          sent_at: string | null
          sent_by: string | null
          status: string
          subject: string | null
        }
        Insert: {
          attachment_filename?: string | null
          bcc_emails?: string[] | null
          body?: string | null
          business_id?: string | null
          cc_emails?: string[] | null
          created_at?: string
          document_id: string
          document_record_id?: string | null
          document_type: string
          error_message?: string | null
          had_attachment?: boolean | null
          id?: string
          message?: string | null
          organization_id: string
          pdf_file_size_bytes?: number | null
          pdf_generated_at?: string | null
          pdf_storage_path?: string | null
          provider_message_id?: string | null
          recipient_email: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string | null
        }
        Update: {
          attachment_filename?: string | null
          bcc_emails?: string[] | null
          body?: string | null
          business_id?: string | null
          cc_emails?: string[] | null
          created_at?: string
          document_id?: string
          document_record_id?: string | null
          document_type?: string
          error_message?: string | null
          had_attachment?: boolean | null
          id?: string
          message?: string | null
          organization_id?: string
          pdf_file_size_bytes?: number | null
          pdf_generated_at?: string | null
          pdf_storage_path?: string | null
          provider_message_id?: string | null
          recipient_email?: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_emails_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_emails_document_record_id_fkey"
            columns: ["document_record_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_emails_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_emails_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_emails_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_header_footer: {
        Row: {
          ast: Json
          business_id: string | null
          code: string | null
          created_at: string
          id: string
          is_active: boolean | null
          is_system: boolean | null
          kind: string
          label: string | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          ast?: Json
          business_id?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean | null
          is_system?: boolean | null
          kind?: string
          label?: string | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          ast?: Json
          business_id?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean | null
          is_system?: boolean | null
          kind?: string
          label?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_header_footer_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_header_footer_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_header_footer_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_header_footer_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_kinds: {
        Row: {
          allowed_formats: string[]
          code: string
          created_at: string
          default_intents: string[]
          default_media_class: string
          domain: string
          is_active: boolean
          label: string
          legal_class: string
          requires_party: boolean
          updated_at: string
        }
        Insert: {
          allowed_formats?: string[]
          code: string
          created_at?: string
          default_intents?: string[]
          default_media_class?: string
          domain: string
          is_active?: boolean
          label: string
          legal_class?: string
          requires_party?: boolean
          updated_at?: string
        }
        Update: {
          allowed_formats?: string[]
          code?: string
          created_at?: string
          default_intents?: string[]
          default_media_class?: string
          domain?: string
          is_active?: boolean
          label?: string
          legal_class?: string
          requires_party?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      document_number_counters: {
        Row: {
          branch_id: string | null
          business_id: string
          current_value: number
          id: string
          period_key: string
          sequence_key: string
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          business_id: string
          current_value?: number
          id?: string
          period_key?: string
          sequence_key: string
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          business_id?: string
          current_value?: number
          id?: string
          period_key?: string
          sequence_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_number_counters_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_number_counters_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      document_number_rules: {
        Row: {
          branch_id: string | null
          business_id: string
          created_at: string
          id: string
          padding: number
          period_reset: string
          prefix: string
          sequence_key: string
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          padding?: number
          period_reset?: string
          prefix: string
          sequence_key: string
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          padding?: number
          period_reset?: string
          prefix?: string
          sequence_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_number_rules_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_number_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      document_print_policies: {
        Row: {
          auto_print: boolean | null
          branch_id: string | null
          business_id: string
          copies: number
          created_at: string
          created_by: string | null
          document_type: string
          id: string
          intent: string | null
          organization_id: string
          paper_format: string | null
          render_mode: string | null
          role_code: string | null
          trigger: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          auto_print?: boolean | null
          branch_id?: string | null
          business_id: string
          copies?: number
          created_at?: string
          created_by?: string | null
          document_type: string
          id?: string
          intent?: string | null
          organization_id: string
          paper_format?: string | null
          render_mode?: string | null
          role_code?: string | null
          trigger?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          auto_print?: boolean | null
          branch_id?: string | null
          business_id?: string
          copies?: number
          created_at?: string
          created_by?: string | null
          document_type?: string
          id?: string
          intent?: string | null
          organization_id?: string
          paper_format?: string | null
          render_mode?: string | null
          role_code?: string | null
          trigger?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_print_policies_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_print_policies_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_print_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_print_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_print_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_records: {
        Row: {
          branch_id: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          document_date: string | null
          document_number: string | null
          id: string
          kind_code: string
          locale: string | null
          metadata: Json
          organization_id: string
          party_id: string | null
          party_kind: string | null
          snapshot: Json | null
          source_doc_id: string
          source_doc_type: string
          source_event_id: string | null
          source_module: string
          status: string | null
          superseded_by: string | null
          updated_at: string
          version: number | null
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          document_date?: string | null
          document_number?: string | null
          id?: string
          kind_code: string
          locale?: string | null
          metadata?: Json
          organization_id: string
          party_id?: string | null
          party_kind?: string | null
          snapshot?: Json | null
          source_doc_id: string
          source_doc_type: string
          source_event_id?: string | null
          source_module: string
          status?: string | null
          superseded_by?: string | null
          updated_at?: string
          version?: number | null
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          document_date?: string | null
          document_number?: string | null
          id?: string
          kind_code?: string
          locale?: string | null
          metadata?: Json
          organization_id?: string
          party_id?: string | null
          party_kind?: string | null
          snapshot?: Json | null
          source_doc_id?: string
          source_doc_type?: string
          source_event_id?: string | null
          source_module?: string
          status?: string | null
          superseded_by?: string | null
          updated_at?: string
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_records_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_records_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_records_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
        ]
      }
      document_template_ast: {
        Row: {
          ast: Json
          branch_id: string | null
          created_at: string
          created_by: string | null
          footer_id: string | null
          header_id: string | null
          id: string
          is_active: boolean
          is_default: boolean
          kind_code: string | null
          label: string | null
          media_class: string | null
          organization_id: string | null
          published_at: string | null
          scope: string | null
          theme_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          ast?: Json
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          footer_id?: string | null
          header_id?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          kind_code?: string | null
          label?: string | null
          media_class?: string | null
          organization_id?: string | null
          published_at?: string | null
          scope?: string | null
          theme_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          ast?: Json
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          footer_id?: string | null
          header_id?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          kind_code?: string | null
          label?: string | null
          media_class?: string | null
          organization_id?: string | null
          published_at?: string | null
          scope?: string | null
          theme_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "document_template_ast_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_template_ast_footer_id_fkey"
            columns: ["footer_id"]
            isOneToOne: false
            referencedRelation: "document_header_footer"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_template_ast_header_id_fkey"
            columns: ["header_id"]
            isOneToOne: false
            referencedRelation: "document_header_footer"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_template_ast_kind_code_fkey"
            columns: ["kind_code"]
            isOneToOne: false
            referencedRelation: "document_kinds"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "document_template_ast_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_template_ast_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_template_ast_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_template_ast_theme_id_fkey"
            columns: ["theme_id"]
            isOneToOne: false
            referencedRelation: "document_theme"
            referencedColumns: ["id"]
          },
        ]
      }
      document_theme: {
        Row: {
          business_id: string | null
          code: string | null
          created_at: string
          id: string
          is_active: boolean | null
          is_default: boolean
          label: string | null
          name: string
          organization_id: string
          tokens: Json
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean | null
          is_default?: boolean
          label?: string | null
          name: string
          organization_id: string
          tokens?: Json
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          code?: string | null
          created_at?: string
          id?: string
          is_active?: boolean | null
          is_default?: boolean
          label?: string | null
          name?: string
          organization_id?: string
          tokens?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_theme_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_theme_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_theme_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "document_theme_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          branch_id: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          deleted_at: string | null
          description: string | null
          file_path: string | null
          id: string
          is_link: boolean | null
          kind_code: string
          link_url: string | null
          locale: string | null
          locked_at: string | null
          locked_by: string | null
          metadata: Json
          mime_type: string | null
          name: string | null
          organization_id: string
          owner_id: string | null
          party_id: string | null
          party_kind: string | null
          source_doc_id: string | null
          source_doc_type: string | null
          source_event_id: string | null
          source_module: string
          status: string
          superseded_by: string | null
          thumbnail_path: string | null
          updated_at: string
          version: number
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          file_path?: string | null
          id?: string
          is_link?: boolean | null
          kind_code: string
          link_url?: string | null
          locale?: string | null
          locked_at?: string | null
          locked_by?: string | null
          metadata?: Json
          mime_type?: string | null
          name?: string | null
          organization_id: string
          owner_id?: string | null
          party_id?: string | null
          party_kind?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_event_id?: string | null
          source_module: string
          status?: string
          superseded_by?: string | null
          thumbnail_path?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          file_path?: string | null
          id?: string
          is_link?: boolean | null
          kind_code?: string
          link_url?: string | null
          locale?: string | null
          locked_at?: string | null
          locked_by?: string | null
          metadata?: Json
          mime_type?: string | null
          name?: string | null
          organization_id?: string
          owner_id?: string | null
          party_id?: string | null
          party_kind?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_event_id?: string | null
          source_module?: string
          status?: string
          superseded_by?: string | null
          thumbnail_path?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "documents_kind_code_fkey"
            columns: ["kind_code"]
            isOneToOne: false
            referencedRelation: "document_kinds"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      edge_jobs: {
        Row: {
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          deadline_at: string
          error: string | null
          id: string
          idempotency_key: string | null
          op: string
          organization_id: string
          payload: Json
          requested_by: string | null
          result: Json | null
          role: string
          status: string
          updated_at: string
          workstation_id: string
        }
        Insert: {
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          deadline_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string | null
          op?: string
          organization_id: string
          payload?: Json
          requested_by?: string | null
          result?: Json | null
          role: string
          status?: string
          updated_at?: string
          workstation_id: string
        }
        Update: {
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          deadline_at?: string
          error?: string | null
          id?: string
          idempotency_key?: string | null
          op?: string
          organization_id?: string
          payload?: Json
          requested_by?: string | null
          result?: Json | null
          role?: string
          status?: string
          updated_at?: string
          workstation_id?: string
        }
        Relationships: []
      }
      email_event_outbox: {
        Row: {
          attempts: number
          business_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          event_type: string
          id: string
          last_error: string | null
          next_attempt_at: string
          organization_id: string
          processed_at: string | null
          recipient_email: string | null
          recipient_user_id: string | null
          status: string
          template_variables: Json | null
        }
        Insert: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          organization_id: string
          processed_at?: string | null
          recipient_email?: string | null
          recipient_user_id?: string | null
          status?: string
          template_variables?: Json | null
        }
        Update: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          event_type?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          organization_id?: string
          processed_at?: string | null
          recipient_email?: string | null
          recipient_user_id?: string | null
          status?: string
          template_variables?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "email_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "email_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "email_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      email_templates: {
        Row: {
          body: string
          business_id: string
          created_at: string
          created_by: string | null
          html_body: string | null
          id: string
          is_active: boolean
          is_default: boolean | null
          name: string
          organization_id: string
          subject: string
          template_key: string
          text_body: string | null
          updated_at: string
          variables: Json | null
        }
        Insert: {
          body: string
          business_id: string
          created_at?: string
          created_by?: string | null
          html_body?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean | null
          name: string
          organization_id: string
          subject: string
          template_key: string
          text_body?: string | null
          updated_at?: string
          variables?: Json | null
        }
        Update: {
          body?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          html_body?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean | null
          name?: string
          organization_id?: string
          subject?: string
          template_key?: string
          text_body?: string | null
          updated_at?: string
          variables?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "email_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "email_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "email_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_branch_assignments: {
        Row: {
          assignment_type: string
          branch_id: string
          business_id: string
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          employee_id: string
          id: string
          is_primary: boolean
          notes: string | null
          organization_id: string
          updated_at: string
        }
        Insert: {
          assignment_type?: string
          branch_id: string
          business_id: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          employee_id: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          organization_id: string
          updated_at?: string
        }
        Update: {
          assignment_type?: string
          branch_id?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          employee_id?: string
          id?: string
          is_primary?: boolean
          notes?: string | null
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_branch_assignments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_branch_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_branch_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_branch_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_branch_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_branch_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_documents: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string
          description: string | null
          document_type: string
          employee_id: string
          expiry_date: string | null
          file_name: string | null
          file_path: string | null
          file_size: number | null
          id: string
          is_verified: boolean | null
          mime_type: string | null
          name: string
          organization_id: string
          updated_at: string
          uploaded_by: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          description?: string | null
          document_type?: string
          employee_id: string
          expiry_date?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          is_verified?: boolean | null
          mime_type?: string | null
          name: string
          organization_id: string
          updated_at?: string
          uploaded_by?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          description?: string | null
          document_type?: string
          employee_id?: string
          expiry_date?: string | null
          file_name?: string | null
          file_path?: string | null
          file_size?: number | null
          id?: string
          is_verified?: boolean | null
          mime_type?: string | null
          name?: string
          organization_id?: string
          updated_at?: string
          uploaded_by?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_documents_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employee_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employee_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          avatar_url: string | null
          bank_account_number: string | null
          bank_branch: string | null
          bank_code: string | null
          bank_name: string | null
          basic_salary: number | null
          branch_id: string | null
          business_id: string | null
          city: string | null
          cost_rate_override: number | null
          country: string | null
          county: string | null
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          department: string | null
          department_id: string | null
          draft_owner_id: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          employee_number: string
          employment_type: string | null
          external_attendance_ref: string | null
          first_name: string
          gender: string | null
          hire_date: string
          housing_allowance: number | null
          id: string
          is_active: boolean | null
          job_position_id: string | null
          labor_burden_pct: number
          last_name: string
          lifecycle_status: Database["public"]["Enums"]["employee_lifecycle_status"]
          manager_id: string | null
          marital_status: string | null
          national_id: string | null
          nhif_number: string | null
          nssf_number: string | null
          organization_id: string
          other_allowances: Json | null
          personal_phone: string | null
          phone: string | null
          position: string | null
          postal_code: string | null
          sms_consent: boolean
          sms_consent_recorded_at: string | null
          statutory_country_code: string | null
          tax_pin: string | null
          termination_date: string | null
          transport_allowance: number | null
          updated_at: string
          user_access_status: string
          user_id: string | null
          work_email: string | null
          work_location_id: string | null
          work_schedule_id: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_number?: string | null
          bank_branch?: string | null
          bank_code?: string | null
          bank_name?: string | null
          basic_salary?: number | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          cost_rate_override?: number | null
          country?: string | null
          county?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          department?: string | null
          department_id?: string | null
          draft_owner_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number: string
          employment_type?: string | null
          external_attendance_ref?: string | null
          first_name: string
          gender?: string | null
          hire_date: string
          housing_allowance?: number | null
          id?: string
          is_active?: boolean | null
          job_position_id?: string | null
          labor_burden_pct?: number
          last_name: string
          lifecycle_status?: Database["public"]["Enums"]["employee_lifecycle_status"]
          manager_id?: string | null
          marital_status?: string | null
          national_id?: string | null
          nhif_number?: string | null
          nssf_number?: string | null
          organization_id: string
          other_allowances?: Json | null
          personal_phone?: string | null
          phone?: string | null
          position?: string | null
          postal_code?: string | null
          sms_consent?: boolean
          sms_consent_recorded_at?: string | null
          statutory_country_code?: string | null
          tax_pin?: string | null
          termination_date?: string | null
          transport_allowance?: number | null
          updated_at?: string
          user_access_status?: string
          user_id?: string | null
          work_email?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_number?: string | null
          bank_branch?: string | null
          bank_code?: string | null
          bank_name?: string | null
          basic_salary?: number | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          cost_rate_override?: number | null
          country?: string | null
          county?: string | null
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          department?: string | null
          department_id?: string | null
          draft_owner_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number?: string
          employment_type?: string | null
          external_attendance_ref?: string | null
          first_name?: string
          gender?: string | null
          hire_date?: string
          housing_allowance?: number | null
          id?: string
          is_active?: boolean | null
          job_position_id?: string | null
          labor_burden_pct?: number
          last_name?: string
          lifecycle_status?: Database["public"]["Enums"]["employee_lifecycle_status"]
          manager_id?: string | null
          marital_status?: string | null
          national_id?: string | null
          nhif_number?: string | null
          nssf_number?: string | null
          organization_id?: string
          other_allowances?: Json | null
          personal_phone?: string | null
          phone?: string | null
          position?: string | null
          postal_code?: string | null
          sms_consent?: boolean
          sms_consent_recorded_at?: string | null
          statutory_country_code?: string | null
          tax_pin?: string | null
          termination_date?: string | null
          transport_allowance?: number | null
          updated_at?: string
          user_access_status?: string
          user_id?: string | null
          work_email?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_field_configs: {
        Row: {
          business_id: string | null
          computation_dependencies: string[] | null
          computation_formula: string | null
          conditional_visibility: Json | null
          created_at: string
          created_by: string | null
          default_value: string | null
          display_order: number | null
          document_section: string | null
          entity_type: string
          field_group: string | null
          field_key: string
          field_label: string
          field_type: string
          help_text: string | null
          id: string
          is_filterable: boolean | null
          is_required: boolean | null
          is_searchable: boolean | null
          is_visible: boolean | null
          options: Json | null
          organization_id: string
          placeholder: string | null
          related_display_field: string | null
          related_filter: Json | null
          related_model: string | null
          updated_at: string
          validation_rules: Json | null
        }
        Insert: {
          business_id?: string | null
          computation_dependencies?: string[] | null
          computation_formula?: string | null
          conditional_visibility?: Json | null
          created_at?: string
          created_by?: string | null
          default_value?: string | null
          display_order?: number | null
          document_section?: string | null
          entity_type: string
          field_group?: string | null
          field_key: string
          field_label: string
          field_type?: string
          help_text?: string | null
          id?: string
          is_filterable?: boolean | null
          is_required?: boolean | null
          is_searchable?: boolean | null
          is_visible?: boolean | null
          options?: Json | null
          organization_id: string
          placeholder?: string | null
          related_display_field?: string | null
          related_filter?: Json | null
          related_model?: string | null
          updated_at?: string
          validation_rules?: Json | null
        }
        Update: {
          business_id?: string | null
          computation_dependencies?: string[] | null
          computation_formula?: string | null
          conditional_visibility?: Json | null
          created_at?: string
          created_by?: string | null
          default_value?: string | null
          display_order?: number | null
          document_section?: string | null
          entity_type?: string
          field_group?: string | null
          field_key?: string
          field_label?: string
          field_type?: string
          help_text?: string | null
          id?: string
          is_filterable?: boolean | null
          is_required?: boolean | null
          is_searchable?: boolean | null
          is_visible?: boolean | null
          options?: Json | null
          organization_id?: string
          placeholder?: string | null
          related_display_field?: string | null
          related_filter?: Json | null
          related_model?: string | null
          updated_at?: string
          validation_rules?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "entity_field_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "entity_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "entity_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_field_values: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          field_config_id: string
          field_key: string
          field_value: string | null
          field_value_json: Json | null
          id: string
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          field_config_id: string
          field_key: string
          field_value?: string | null
          field_value_json?: Json | null
          id?: string
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          field_config_id?: string
          field_key?: string
          field_value?: string | null
          field_value_json?: Json | null
          id?: string
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "entity_field_values_field_config_id_fkey"
            columns: ["field_config_id"]
            isOneToOne: false
            referencedRelation: "entity_field_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_field_values_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "entity_field_values_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "entity_field_values_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      etims_transmission_logs: {
        Row: {
          api_endpoint: string
          business_id: string | null
          created_at: string | null
          document_id: string
          document_number: string | null
          document_type: string
          error_message: string | null
          id: string
          max_retries: number | null
          next_retry_at: string | null
          organization_id: string
          request_payload: Json | null
          response_code: string | null
          response_message: string | null
          response_payload: Json | null
          retry_count: number | null
          status: string
          transmitted_at: string | null
        }
        Insert: {
          api_endpoint: string
          business_id?: string | null
          created_at?: string | null
          document_id: string
          document_number?: string | null
          document_type: string
          error_message?: string | null
          id?: string
          max_retries?: number | null
          next_retry_at?: string | null
          organization_id: string
          request_payload?: Json | null
          response_code?: string | null
          response_message?: string | null
          response_payload?: Json | null
          retry_count?: number | null
          status?: string
          transmitted_at?: string | null
        }
        Update: {
          api_endpoint?: string
          business_id?: string | null
          created_at?: string | null
          document_id?: string
          document_number?: string | null
          document_type?: string
          error_message?: string | null
          id?: string
          max_retries?: number | null
          next_retry_at?: string | null
          organization_id?: string
          request_payload?: Json | null
          response_code?: string | null
          response_message?: string | null
          response_payload?: Json | null
          retry_count?: number | null
          status?: string
          transmitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "etims_transmission_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "etims_transmission_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "etims_transmission_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "etims_transmission_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      exchange_rate_audit: {
        Row: {
          actor_id: string | null
          business_id: string
          created_at: string
          effective_date: string
          exchange_rate_id: string
          from_currency: string
          id: string
          organization_id: string
          prior_effective_date: string | null
          prior_rate: number | null
          prior_rate_id: string | null
          prior_source: string | null
          rate: number
          reason: string | null
          source: string
          to_currency: string
        }
        Insert: {
          actor_id?: string | null
          business_id: string
          created_at?: string
          effective_date: string
          exchange_rate_id: string
          from_currency: string
          id?: string
          organization_id: string
          prior_effective_date?: string | null
          prior_rate?: number | null
          prior_rate_id?: string | null
          prior_source?: string | null
          rate: number
          reason?: string | null
          source: string
          to_currency: string
        }
        Update: {
          actor_id?: string | null
          business_id?: string
          created_at?: string
          effective_date?: string
          exchange_rate_id?: string
          from_currency?: string
          id?: string
          organization_id?: string
          prior_effective_date?: string | null
          prior_rate?: number | null
          prior_rate_id?: string | null
          prior_source?: string | null
          rate?: number
          reason?: string | null
          source?: string
          to_currency?: string
        }
        Relationships: []
      }
      exchange_rates: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          effective_date: string | null
          from_currency: string
          id: string
          organization_id: string
          provider_key: string | null
          published_at: string
          rate: number
          rate_date: string
          source: string | null
          to_currency: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          effective_date?: string | null
          from_currency: string
          id?: string
          organization_id: string
          provider_key?: string | null
          published_at?: string
          rate: number
          rate_date?: string
          source?: string | null
          to_currency: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          effective_date?: string | null
          from_currency?: string
          id?: string
          organization_id?: string
          provider_key?: string | null
          published_at?: string
          rate?: number
          rate_date?: string
          source?: string | null
          to_currency?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exchange_rates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exchange_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "exchange_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "exchange_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_attachments: {
        Row: {
          business_id: string | null
          content_type: string | null
          created_at: string
          expense_id: string
          file_name: string | null
          id: string
          kind: string
          organization_id: string
          size_bytes: number | null
          storage_path: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          business_id?: string | null
          content_type?: string | null
          created_at?: string
          expense_id: string
          file_name?: string | null
          id?: string
          kind?: string
          organization_id: string
          size_bytes?: number | null
          storage_path: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          business_id?: string | null
          content_type?: string | null
          created_at?: string
          expense_id?: string
          file_name?: string | null
          id?: string
          kind?: string
          organization_id?: string
          size_bytes?: number | null
          storage_path?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expense_attachments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_categories: {
        Row: {
          account_id: string | null
          business_id: string
          color: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
        }
        Insert: {
          account_id?: string | null
          business_id: string
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
        }
        Update: {
          account_id?: string | null
          business_id?: string
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_categories_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_categories_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_categories_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "expense_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "expense_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          account_id: string | null
          amount: number
          analytic_account_id: string | null
          approval_request_id: string | null
          approved_at: string | null
          approved_by: string | null
          base_amount: number | null
          branch_id: string | null
          business_id: string
          category_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          department_id: string | null
          description: string
          employee_id: string | null
          exchange_rate: number
          expense_date: string
          expense_number: string | null
          id: string
          is_billable: boolean | null
          is_sample_data: boolean
          journal_entry_id: string | null
          organization_id: string
          paid_by: string
          payment_account_id: string | null
          payment_method: string
          receipt_url: string | null
          reference: string | null
          reimburse_via_payroll: boolean
          reimbursed_at: string | null
          reimbursed_payslip_id: string | null
          reimbursed_run_id: string | null
          rejected_reason: string | null
          status: Database["public"]["Enums"]["expense_status"]
          submitted_at: string | null
          submitted_by: string | null
          task_id: string | null
          tax_amount: number | null
          tax_rate_id: string | null
          tax_treatment: string
          updated_at: string
          vendor_id: string | null
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          account_id?: string | null
          amount: number
          analytic_account_id?: string | null
          approval_request_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          base_amount?: number | null
          branch_id?: string | null
          business_id: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          department_id?: string | null
          description: string
          employee_id?: string | null
          exchange_rate: number
          expense_date?: string
          expense_number?: string | null
          id?: string
          is_billable?: boolean | null
          is_sample_data?: boolean
          journal_entry_id?: string | null
          organization_id: string
          paid_by?: string
          payment_account_id?: string | null
          payment_method?: string
          receipt_url?: string | null
          reference?: string | null
          reimburse_via_payroll?: boolean
          reimbursed_at?: string | null
          reimbursed_payslip_id?: string | null
          reimbursed_run_id?: string | null
          rejected_reason?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          task_id?: string | null
          tax_amount?: number | null
          tax_rate_id?: string | null
          tax_treatment?: string
          updated_at?: string
          vendor_id?: string | null
          void_reason?: string | null
          void_reason_code?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          account_id?: string | null
          amount?: number
          analytic_account_id?: string | null
          approval_request_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          base_amount?: number | null
          branch_id?: string | null
          business_id?: string
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          department_id?: string | null
          description?: string
          employee_id?: string | null
          exchange_rate?: number
          expense_date?: string
          expense_number?: string | null
          id?: string
          is_billable?: boolean | null
          is_sample_data?: boolean
          journal_entry_id?: string | null
          organization_id?: string
          paid_by?: string
          payment_account_id?: string | null
          payment_method?: string
          receipt_url?: string | null
          reference?: string | null
          reimburse_via_payroll?: boolean
          reimbursed_at?: string | null
          reimbursed_payslip_id?: string | null
          reimbursed_run_id?: string | null
          rejected_reason?: string | null
          status?: Database["public"]["Enums"]["expense_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          task_id?: string | null
          tax_amount?: number | null
          tax_rate_id?: string | null
          tax_treatment?: string
          updated_at?: string
          vendor_id?: string | null
          void_reason?: string | null
          void_reason_code?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_analytic_account_id_fkey"
            columns: ["analytic_account_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_approval_request_id_fkey"
            columns: ["approval_request_id"]
            isOneToOne: false
            referencedRelation: "reversal_register"
            referencedColumns: ["approval_request_id"]
          },
          {
            foreignKeyName: "expenses_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "expense_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "expenses_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "expenses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "expenses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_payment_account_id_fkey"
            columns: ["payment_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_payment_account_id_fkey"
            columns: ["payment_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tax_rate_id_fkey"
            columns: ["tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_alert_drift_streaks: {
        Row: {
          business_id: string
          consecutive_days: number
          last_evaluated_at: string
          last_notified_at: string | null
          last_seen_count: number
          metric: string
        }
        Insert: {
          business_id: string
          consecutive_days?: number
          last_evaluated_at?: string
          last_notified_at?: string | null
          last_seen_count?: number
          metric: string
        }
        Update: {
          business_id?: string
          consecutive_days?: number
          last_evaluated_at?: string
          last_notified_at?: string | null
          last_seen_count?: number
          metric?: string
        }
        Relationships: []
      }
      finance_integrity_issues: {
        Row: {
          business_id: string | null
          details: Json
          detected_at: string
          id: string
          issue_code: string
          organization_id: string
          resolved_at: string | null
          resolved_by: string | null
          resolved_note: string | null
          severity: string
          source_id: string | null
          source_type: string
        }
        Insert: {
          business_id?: string | null
          details?: Json
          detected_at?: string
          id?: string
          issue_code: string
          organization_id: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_note?: string | null
          severity?: string
          source_id?: string | null
          source_type: string
        }
        Update: {
          business_id?: string | null
          details?: Json
          detected_at?: string
          id?: string
          issue_code?: string
          organization_id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_note?: string | null
          severity?: string
          source_id?: string | null
          source_type?: string
        }
        Relationships: []
      }
      fiscal_device_credentials: {
        Row: {
          branch_id: string | null
          branch_office_id: string | null
          business_id: string
          communication_key_encrypted: string | null
          created_at: string
          credential_expires_at: string | null
          credential_rotated_at: string | null
          device_serial: string | null
          environment: string
          id: string
          initialized_at: string | null
          is_active: boolean
          last_health_check_at: string | null
          last_health_ok: boolean | null
          metadata: Json
          organization_id: string
          provider_key: string
          tax_pin: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          branch_office_id?: string | null
          business_id: string
          communication_key_encrypted?: string | null
          created_at?: string
          credential_expires_at?: string | null
          credential_rotated_at?: string | null
          device_serial?: string | null
          environment?: string
          id?: string
          initialized_at?: string | null
          is_active?: boolean
          last_health_check_at?: string | null
          last_health_ok?: boolean | null
          metadata?: Json
          organization_id: string
          provider_key: string
          tax_pin?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          branch_office_id?: string | null
          business_id?: string
          communication_key_encrypted?: string | null
          created_at?: string
          credential_expires_at?: string | null
          credential_rotated_at?: string | null
          device_serial?: string | null
          environment?: string
          id?: string
          initialized_at?: string | null
          is_active?: boolean
          last_health_check_at?: string | null
          last_health_ok?: boolean | null
          metadata?: Json
          organization_id?: string
          provider_key?: string
          tax_pin?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      fiscal_periods: {
        Row: {
          business_id: string
          closed_at: string | null
          closing_entry_id: string | null
          created_at: string
          end_date: string
          id: string
          is_closed: boolean
          locked_at: string | null
          locked_by: string | null
          name: string
          notes: string | null
          organization_id: string
          period_type: string | null
          start_date: string
          status: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          closed_at?: string | null
          closing_entry_id?: string | null
          created_at?: string
          end_date: string
          id?: string
          is_closed?: boolean
          locked_at?: string | null
          locked_by?: string | null
          name: string
          notes?: string | null
          organization_id: string
          period_type?: string | null
          start_date: string
          status?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          closed_at?: string | null
          closing_entry_id?: string | null
          created_at?: string
          end_date?: string
          id?: string
          is_closed?: boolean
          locked_at?: string | null
          locked_by?: string | null
          name?: string
          notes?: string | null
          organization_id?: string
          period_type?: string | null
          start_date?: string
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_periods_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "fiscal_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "fiscal_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      fiscal_transmissions: {
        Row: {
          attempt_count: number
          branch_id: string | null
          business_id: string | null
          control_unit_id: string | null
          created_at: string
          document_kind: string
          event_id: string | null
          fiscal_number: string | null
          id: string
          idempotency_key: string
          last_error: string | null
          next_attempt_at: string | null
          organization_id: string
          original_fiscal_number: string | null
          original_transmission_id: string | null
          provider_key: string
          qr_data: string | null
          request_payload: Json | null
          response_payload: Json | null
          sequence_no: number
          signature: string | null
          source_doc_id: string
          source_doc_type: string
          state: string
          superseded_by: string | null
          transmitted_at: string | null
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          branch_id?: string | null
          business_id?: string | null
          control_unit_id?: string | null
          created_at?: string
          document_kind: string
          event_id?: string | null
          fiscal_number?: string | null
          id?: string
          idempotency_key: string
          last_error?: string | null
          next_attempt_at?: string | null
          organization_id: string
          original_fiscal_number?: string | null
          original_transmission_id?: string | null
          provider_key: string
          qr_data?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          sequence_no?: number
          signature?: string | null
          source_doc_id: string
          source_doc_type: string
          state?: string
          superseded_by?: string | null
          transmitted_at?: string | null
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          branch_id?: string | null
          business_id?: string | null
          control_unit_id?: string | null
          created_at?: string
          document_kind?: string
          event_id?: string | null
          fiscal_number?: string | null
          id?: string
          idempotency_key?: string
          last_error?: string | null
          next_attempt_at?: string | null
          organization_id?: string
          original_fiscal_number?: string | null
          original_transmission_id?: string | null
          provider_key?: string
          qr_data?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          sequence_no?: number
          signature?: string | null
          source_doc_id?: string
          source_doc_type?: string
          state?: string
          superseded_by?: string | null
          transmitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fiscal_transmissions_original_transmission_id_fkey"
            columns: ["original_transmission_id"]
            isOneToOne: false
            referencedRelation: "fiscal_transmissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fiscal_transmissions_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "fiscal_transmissions"
            referencedColumns: ["id"]
          },
        ]
      }
      fixed_assets: {
        Row: {
          accumulated_depreciation: number | null
          acquisition_exchange_rate: number
          asset_number: string
          assigned_at: string | null
          assigned_to: string | null
          assigned_to_employee_id: string | null
          assignment_notes: string | null
          barcode: string | null
          base_disposal_price: number | null
          base_purchase_price: number
          base_residual_value: number
          book_value: number | null
          branch_id: string | null
          business_id: string | null
          category_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          depreciation_method: string | null
          depreciation_start_date: string | null
          description: string | null
          disposal_date: string | null
          disposal_exchange_rate: number | null
          disposal_price: number | null
          disposal_reason: string | null
          id: string
          insurance_expiry: string | null
          insurance_policy: string | null
          insurance_value: number | null
          invoice_reference: string | null
          location: string | null
          name: string
          notes: string | null
          organization_id: string
          purchase_date: string
          purchase_price: number
          residual_value: number | null
          returned_at: string | null
          serial_number: string | null
          status: string | null
          updated_at: string
          useful_life_years: number | null
          vendor_id: string | null
          warranty_expiry: string | null
        }
        Insert: {
          accumulated_depreciation?: number | null
          acquisition_exchange_rate: number
          asset_number: string
          assigned_at?: string | null
          assigned_to?: string | null
          assigned_to_employee_id?: string | null
          assignment_notes?: string | null
          barcode?: string | null
          base_disposal_price?: number | null
          base_purchase_price: number
          base_residual_value: number
          book_value?: number | null
          branch_id?: string | null
          business_id?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency: string
          depreciation_method?: string | null
          depreciation_start_date?: string | null
          description?: string | null
          disposal_date?: string | null
          disposal_exchange_rate?: number | null
          disposal_price?: number | null
          disposal_reason?: string | null
          id?: string
          insurance_expiry?: string | null
          insurance_policy?: string | null
          insurance_value?: number | null
          invoice_reference?: string | null
          location?: string | null
          name: string
          notes?: string | null
          organization_id: string
          purchase_date: string
          purchase_price: number
          residual_value?: number | null
          returned_at?: string | null
          serial_number?: string | null
          status?: string | null
          updated_at?: string
          useful_life_years?: number | null
          vendor_id?: string | null
          warranty_expiry?: string | null
        }
        Update: {
          accumulated_depreciation?: number | null
          acquisition_exchange_rate?: number
          asset_number?: string
          assigned_at?: string | null
          assigned_to?: string | null
          assigned_to_employee_id?: string | null
          assignment_notes?: string | null
          barcode?: string | null
          base_disposal_price?: number | null
          base_purchase_price?: number
          base_residual_value?: number
          book_value?: number | null
          branch_id?: string | null
          business_id?: string | null
          category_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          depreciation_method?: string | null
          depreciation_start_date?: string | null
          description?: string | null
          disposal_date?: string | null
          disposal_exchange_rate?: number | null
          disposal_price?: number | null
          disposal_reason?: string | null
          id?: string
          insurance_expiry?: string | null
          insurance_policy?: string | null
          insurance_value?: number | null
          invoice_reference?: string | null
          location?: string | null
          name?: string
          notes?: string | null
          organization_id?: string
          purchase_date?: string
          purchase_price?: number
          residual_value?: number | null
          returned_at?: string | null
          serial_number?: string | null
          status?: string | null
          updated_at?: string
          useful_life_years?: number | null
          vendor_id?: string | null
          warranty_expiry?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixed_assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "asset_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "fixed_assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "fixed_assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      form_conditional_rules: {
        Row: {
          action_value: string | null
          condition_expression: Json
          created_at: string
          field_key: string
          form_layout_id: string
          id: string
          rule_type: string
        }
        Insert: {
          action_value?: string | null
          condition_expression: Json
          created_at?: string
          field_key: string
          form_layout_id: string
          id?: string
          rule_type: string
        }
        Update: {
          action_value?: string | null
          condition_expression?: Json
          created_at?: string
          field_key?: string
          form_layout_id?: string
          id?: string
          rule_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_conditional_rules_form_layout_id_fkey"
            columns: ["form_layout_id"]
            isOneToOne: false
            referencedRelation: "form_layouts"
            referencedColumns: ["id"]
          },
        ]
      }
      form_layouts: {
        Row: {
          created_at: string
          created_by: string | null
          entity_type: string
          id: string
          is_default: boolean | null
          layout_config: Json
          layout_name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entity_type: string
          id?: string
          is_default?: boolean | null
          layout_config?: Json
          layout_name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entity_type?: string
          id?: string
          is_default?: boolean | null
          layout_config?: Json
          layout_name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "form_layouts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "form_layouts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "form_layouts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      format_registry: {
        Row: {
          created_at: string
          ext: string
          format: string
          label: string
          mime: string
          role_hint: string | null
          writer: string | null
        }
        Insert: {
          created_at?: string
          ext: string
          format: string
          label: string
          mime: string
          role_hint?: string | null
          writer?: string | null
        }
        Update: {
          created_at?: string
          ext?: string
          format?: string
          label?: string
          mime?: string
          role_hint?: string | null
          writer?: string | null
        }
        Relationships: []
      }
      fx_revaluation_lines: {
        Row: {
          account_id: string
          base_balance_new: number
          base_balance_old: number
          created_at: string
          currency: string
          delta: number
          foreign_balance: number
          id: string
          new_rate: number
          old_rate: number
          run_id: string
        }
        Insert: {
          account_id: string
          base_balance_new: number
          base_balance_old: number
          created_at?: string
          currency: string
          delta: number
          foreign_balance: number
          id?: string
          new_rate: number
          old_rate: number
          run_id: string
        }
        Update: {
          account_id?: string
          base_balance_new?: number
          base_balance_old?: number
          created_at?: string
          currency?: string
          delta?: number
          foreign_balance?: number
          id?: string
          new_rate?: number
          old_rate?: number
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fx_revaluation_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_lines_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "fx_revaluation_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      fx_revaluation_runs: {
        Row: {
          base_currency: string
          business_id: string
          created_at: string
          created_by: string | null
          fiscal_period_id: string | null
          id: string
          journal_book_id: string | null
          journal_entry_id: string | null
          notes: string | null
          organization_id: string
          reversal_journal_entry_id: string | null
          reversal_policy: string
          reversed_at: string | null
          reversed_by_run_id: string | null
          run_date: string
          status: string
          total_unrealized_gain: number
          total_unrealized_loss: number
          unrealized_gain_account_id: string | null
          unrealized_loss_account_id: string | null
          updated_at: string
        }
        Insert: {
          base_currency: string
          business_id: string
          created_at?: string
          created_by?: string | null
          fiscal_period_id?: string | null
          id?: string
          journal_book_id?: string | null
          journal_entry_id?: string | null
          notes?: string | null
          organization_id: string
          reversal_journal_entry_id?: string | null
          reversal_policy?: string
          reversed_at?: string | null
          reversed_by_run_id?: string | null
          run_date: string
          status?: string
          total_unrealized_gain?: number
          total_unrealized_loss?: number
          unrealized_gain_account_id?: string | null
          unrealized_loss_account_id?: string | null
          updated_at?: string
        }
        Update: {
          base_currency?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          fiscal_period_id?: string | null
          id?: string
          journal_book_id?: string | null
          journal_entry_id?: string | null
          notes?: string | null
          organization_id?: string
          reversal_journal_entry_id?: string | null
          reversal_policy?: string
          reversed_at?: string | null
          reversed_by_run_id?: string | null
          run_date?: string
          status?: string
          total_unrealized_gain?: number
          total_unrealized_loss?: number
          unrealized_gain_account_id?: string | null
          unrealized_loss_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fx_revaluation_runs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_fiscal_period_id_fkey"
            columns: ["fiscal_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_journal_book_id_fkey"
            columns: ["journal_book_id"]
            isOneToOne: false
            referencedRelation: "journal_books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_reversed_by_run_id_fkey"
            columns: ["reversed_by_run_id"]
            isOneToOne: false
            referencedRelation: "fx_revaluation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_unrealized_gain_account_id_fkey"
            columns: ["unrealized_gain_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_unrealized_gain_account_id_fkey"
            columns: ["unrealized_gain_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_unrealized_loss_account_id_fkey"
            columns: ["unrealized_loss_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_revaluation_runs_unrealized_loss_account_id_fkey"
            columns: ["unrealized_loss_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      gl_transaction_mappings: {
        Row: {
          business_id: string | null
          created_at: string
          credit_account_id: string | null
          debit_account_id: string | null
          description_template: string | null
          id: string
          is_active: boolean | null
          organization_id: string
          transaction_type: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          credit_account_id?: string | null
          debit_account_id?: string | null
          description_template?: string | null
          id?: string
          is_active?: boolean | null
          organization_id: string
          transaction_type: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          credit_account_id?: string | null
          debit_account_id?: string | null
          description_template?: string | null
          id?: string
          is_active?: boolean | null
          organization_id?: string
          transaction_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gl_transaction_mappings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_credit_account_id_fkey"
            columns: ["credit_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_credit_account_id_fkey"
            columns: ["credit_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_debit_account_id_fkey"
            columns: ["debit_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_debit_account_id_fkey"
            columns: ["debit_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "gl_transaction_mappings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      governance_action_registry: {
        Row: {
          action_key: string
          created_at: string
          description: string
          is_active: boolean
          label: string
          module: string
          requires_approval_always: boolean
          severity_default: string
          subject_mode: string
          subject_table: string | null
          updated_at: string
        }
        Insert: {
          action_key: string
          created_at?: string
          description: string
          is_active?: boolean
          label: string
          module: string
          requires_approval_always?: boolean
          severity_default?: string
          subject_mode: string
          subject_table?: string | null
          updated_at?: string
        }
        Update: {
          action_key?: string
          created_at?: string
          description?: string
          is_active?: boolean
          label?: string
          module?: string
          requires_approval_always?: boolean
          severity_default?: string
          subject_mode?: string
          subject_table?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      governance_duties: {
        Row: {
          created_at: string
          description: string | null
          domain: string
          duty_code: string
          label: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          domain: string
          duty_code: string
          label: string
        }
        Update: {
          created_at?: string
          description?: string | null
          domain?: string
          duty_code?: string
          label?: string
        }
        Relationships: []
      }
      governance_duty_permission_map: {
        Row: {
          created_at: string
          duty_code: string
          id: string
          module: string
          operation: string
        }
        Insert: {
          created_at?: string
          duty_code: string
          id?: string
          module: string
          operation: string
        }
        Update: {
          created_at?: string
          duty_code?: string
          id?: string
          module?: string
          operation?: string
        }
        Relationships: [
          {
            foreignKeyName: "governance_duty_permission_map_duty_code_fkey"
            columns: ["duty_code"]
            isOneToOne: false
            referencedRelation: "governance_duties"
            referencedColumns: ["duty_code"]
          },
        ]
      }
      governance_events: {
        Row: {
          actor_id: string | null
          error_message: string | null
          event_type: string
          finished_at: string | null
          id: string
          module_keys: string[]
          organization_id: string
          payload: Json
          result: Json | null
          started_at: string
          succeeded: boolean | null
        }
        Insert: {
          actor_id?: string | null
          error_message?: string | null
          event_type: string
          finished_at?: string | null
          id?: string
          module_keys?: string[]
          organization_id: string
          payload?: Json
          result?: Json | null
          started_at?: string
          succeeded?: boolean | null
        }
        Update: {
          actor_id?: string | null
          error_message?: string | null
          event_type?: string
          finished_at?: string | null
          id?: string
          module_keys?: string[]
          organization_id?: string
          payload?: Json
          result?: Json | null
          started_at?: string
          succeeded?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "governance_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "governance_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "governance_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      governance_export_jobs: {
        Row: {
          created_at: string
          error_message: string | null
          finished_at: string | null
          id: string
          manifest_path: string | null
          module_keys: string[]
          organization_id: string
          requested_by: string | null
          row_counts: Json
          sha256: string | null
          started_at: string
          status: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          manifest_path?: string | null
          module_keys?: string[]
          organization_id: string
          requested_by?: string | null
          row_counts?: Json
          sha256?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          finished_at?: string | null
          id?: string
          manifest_path?: string | null
          module_keys?: string[]
          organization_id?: string
          requested_by?: string | null
          row_counts?: Json
          sha256?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "governance_export_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "governance_export_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "governance_export_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      governance_modules: {
        Row: {
          depends_on: string[]
          derived_projections: string[]
          description: string | null
          display_name: string
          export_fn: string | null
          is_active: boolean
          module_key: string
          owns_sequences: string[]
          owns_storage_prefixes: Json
          owns_tables: string[]
          preview_fn: string | null
          registered_at: string
          teardown_fn: string | null
          updated_at: string
          version: number
        }
        Insert: {
          depends_on?: string[]
          derived_projections?: string[]
          description?: string | null
          display_name: string
          export_fn?: string | null
          is_active?: boolean
          module_key: string
          owns_sequences?: string[]
          owns_storage_prefixes?: Json
          owns_tables?: string[]
          preview_fn?: string | null
          registered_at?: string
          teardown_fn?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          depends_on?: string[]
          derived_projections?: string[]
          description?: string | null
          display_name?: string
          export_fn?: string | null
          is_active?: boolean
          module_key?: string
          owns_sequences?: string[]
          owns_storage_prefixes?: Json
          owns_tables?: string[]
          preview_fn?: string | null
          registered_at?: string
          teardown_fn?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      governance_sod_conflicts: {
        Row: {
          created_at: string
          duty_a: string
          duty_b: string
          id: string
          rationale: string
          severity: string
        }
        Insert: {
          created_at?: string
          duty_a: string
          duty_b: string
          id?: string
          rationale: string
          severity?: string
        }
        Update: {
          created_at?: string
          duty_a?: string
          duty_b?: string
          id?: string
          rationale?: string
          severity?: string
        }
        Relationships: [
          {
            foreignKeyName: "governance_sod_conflicts_duty_a_fkey"
            columns: ["duty_a"]
            isOneToOne: false
            referencedRelation: "governance_duties"
            referencedColumns: ["duty_code"]
          },
          {
            foreignKeyName: "governance_sod_conflicts_duty_b_fkey"
            columns: ["duty_b"]
            isOneToOne: false
            referencedRelation: "governance_duties"
            referencedColumns: ["duty_code"]
          },
        ]
      }
      identity_change_audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          new_employee_user_id: string | null
          new_role: string | null
          new_user_type: string | null
          old_employee_user_id: string | null
          old_role: string | null
          old_user_type: string | null
          organization_id: string
          reason: string | null
          source: string
          target_employee_id: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          new_employee_user_id?: string | null
          new_role?: string | null
          new_user_type?: string | null
          old_employee_user_id?: string | null
          old_role?: string | null
          old_user_type?: string | null
          organization_id: string
          reason?: string | null
          source: string
          target_employee_id?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          new_employee_user_id?: string | null
          new_role?: string | null
          new_user_type?: string | null
          old_employee_user_id?: string | null
          old_role?: string | null
          old_user_type?: string | null
          organization_id?: string
          reason?: string | null
          source?: string
          target_employee_id?: string | null
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "identity_change_audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "identity_change_audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "identity_change_audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      identity_drift_reports: {
        Row: {
          branch_org_mismatch_count: number
          created_at: string
          details: Json | null
          id: string
          multi_business_org_count: number
          org_name_drift_count: number
          ran_at: string
        }
        Insert: {
          branch_org_mismatch_count?: number
          created_at?: string
          details?: Json | null
          id?: string
          multi_business_org_count?: number
          org_name_drift_count?: number
          ran_at?: string
        }
        Update: {
          branch_org_mismatch_count?: number
          created_at?: string
          details?: Json | null
          id?: string
          multi_business_org_count?: number
          org_name_drift_count?: number
          ran_at?: string
        }
        Relationships: []
      }
      iso_currencies: {
        Row: {
          code: string
          created_at: string
          decimal_places: number
          is_active: boolean
          name: string
          symbol: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          decimal_places?: number
          is_active?: boolean
          name: string
          symbol?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          decimal_places?: number
          is_active?: boolean
          name?: string
          symbol?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      je_number_sequences: {
        Row: {
          business_id: string
          id: string
          last_number: number
          organization_id: string
        }
        Insert: {
          business_id: string
          id?: string
          last_number?: number
          organization_id: string
        }
        Update: {
          business_id?: string
          id?: string
          last_number?: number
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "je_number_sequences_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "je_number_sequences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "je_number_sequences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "je_number_sequences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_books: {
        Row: {
          business_id: string
          code: string
          created_at: string
          default_account_id: string | null
          description: string | null
          id: string
          is_active: boolean
          is_system: boolean
          journal_type: string
          name: string
          organization_id: string
          sequence_prefix: string | null
          updated_at: string
        }
        Insert: {
          business_id: string
          code: string
          created_at?: string
          default_account_id?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          journal_type: string
          name: string
          organization_id: string
          sequence_prefix?: string | null
          updated_at?: string
        }
        Update: {
          business_id?: string
          code?: string
          created_at?: string
          default_account_id?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          journal_type?: string
          name?: string
          organization_id?: string
          sequence_prefix?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_books_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_books_default_account_id_fkey"
            columns: ["default_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_books_default_account_id_fkey"
            columns: ["default_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_books_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "journal_books_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "journal_books_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          auto_reverse_date: string | null
          branch_id: string | null
          business_id: string
          created_at: string
          created_by: string | null
          currency: string
          description: string | null
          drill_down_data: Json | null
          entry_date: string
          entry_number: string
          exchange_rate: number | null
          fiscal_period_id: string | null
          id: string
          is_adjusting: boolean | null
          is_adjusting_entry: boolean
          is_closing: boolean | null
          is_closing_entry: boolean | null
          is_opening_entry: boolean | null
          is_reversal: boolean
          is_reversing: boolean | null
          is_sample_data: boolean
          journal_book_id: string | null
          organization_id: string
          posted_at: string | null
          posted_by: string | null
          posted_by_id: string | null
          reference: string | null
          reversal_of_id: string | null
          reversed_at: string | null
          reversed_by_id: string | null
          reversed_entry_id: string | null
          reversed_reason: string | null
          source_doc_id: string | null
          source_doc_type: string | null
          source_id: string | null
          source_module: string | null
          source_subtype: string | null
          source_type: string | null
          status: Database["public"]["Enums"]["journal_status"]
          submitted_at: string | null
          submitted_by: string | null
          total_credit: number
          total_debit: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          auto_reverse_date?: string | null
          branch_id?: string | null
          business_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          drill_down_data?: Json | null
          entry_date?: string
          entry_number: string
          exchange_rate?: number | null
          fiscal_period_id?: string | null
          id?: string
          is_adjusting?: boolean | null
          is_adjusting_entry?: boolean
          is_closing?: boolean | null
          is_closing_entry?: boolean | null
          is_opening_entry?: boolean | null
          is_reversal?: boolean
          is_reversing?: boolean | null
          is_sample_data?: boolean
          journal_book_id?: string | null
          organization_id: string
          posted_at?: string | null
          posted_by?: string | null
          posted_by_id?: string | null
          reference?: string | null
          reversal_of_id?: string | null
          reversed_at?: string | null
          reversed_by_id?: string | null
          reversed_entry_id?: string | null
          reversed_reason?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_id?: string | null
          source_module?: string | null
          source_subtype?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["journal_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          total_credit?: number
          total_debit?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          auto_reverse_date?: string | null
          branch_id?: string | null
          business_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          description?: string | null
          drill_down_data?: Json | null
          entry_date?: string
          entry_number?: string
          exchange_rate?: number | null
          fiscal_period_id?: string | null
          id?: string
          is_adjusting?: boolean | null
          is_adjusting_entry?: boolean
          is_closing?: boolean | null
          is_closing_entry?: boolean | null
          is_opening_entry?: boolean | null
          is_reversal?: boolean
          is_reversing?: boolean | null
          is_sample_data?: boolean
          journal_book_id?: string | null
          organization_id?: string
          posted_at?: string | null
          posted_by?: string | null
          posted_by_id?: string | null
          reference?: string | null
          reversal_of_id?: string | null
          reversed_at?: string | null
          reversed_by_id?: string | null
          reversed_entry_id?: string | null
          reversed_reason?: string | null
          source_doc_id?: string | null
          source_doc_type?: string | null
          source_id?: string | null
          source_module?: string | null
          source_subtype?: string | null
          source_type?: string | null
          status?: Database["public"]["Enums"]["journal_status"]
          submitted_at?: string | null
          submitted_by?: string | null
          total_credit?: number
          total_debit?: number
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_fiscal_period_id_fkey"
            columns: ["fiscal_period_id"]
            isOneToOne: false
            referencedRelation: "fiscal_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_journal_book_id_fkey"
            columns: ["journal_book_id"]
            isOneToOne: false
            referencedRelation: "journal_books"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_reversed_entry_id_fkey"
            columns: ["reversed_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "journal_entries_reversed_entry_id_fkey"
            columns: ["reversed_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_reversed_entry_id_fkey"
            columns: ["reversed_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entry_line_analytics: {
        Row: {
          amount: number
          analytic_account_id: string
          branch_id: string | null
          business_id: string
          created_at: string
          description: string | null
          entry_date: string
          id: string
          journal_entry_id: string
          journal_entry_line_id: string
          organization_id: string
          percentage: number
          plan_id: string
        }
        Insert: {
          amount: number
          analytic_account_id: string
          branch_id?: string | null
          business_id: string
          created_at?: string
          description?: string | null
          entry_date: string
          id?: string
          journal_entry_id: string
          journal_entry_line_id: string
          organization_id: string
          percentage?: number
          plan_id: string
        }
        Update: {
          amount?: number
          analytic_account_id?: string
          branch_id?: string | null
          business_id?: string
          created_at?: string
          description?: string | null
          entry_date?: string
          id?: string
          journal_entry_id?: string
          journal_entry_line_id?: string
          organization_id?: string
          percentage?: number
          plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_entry_line_analytics_analytic_account_id_fkey"
            columns: ["analytic_account_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_line_id_fkey"
            columns: ["journal_entry_line_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["line_id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_line_id_fkey"
            columns: ["journal_entry_line_id"]
            isOneToOne: false
            referencedRelation: "journal_entry_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "analytic_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entry_lines: {
        Row: {
          account_id: string
          analytic_account_id: string | null
          branch_id: string | null
          business_id: string
          contact_id: string | null
          created_at: string
          credit: number
          debit: number
          description: string | null
          exchange_rate: number | null
          id: string
          is_sample_data: boolean
          journal_entry_id: string
          organization_id: string
          original_credit: number | null
          original_currency: string | null
          original_debit: number | null
          sort_order: number
          tax_rate_id: string | null
          tax_tag: string | null
        }
        Insert: {
          account_id: string
          analytic_account_id?: string | null
          branch_id?: string | null
          business_id: string
          contact_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description?: string | null
          exchange_rate?: number | null
          id?: string
          is_sample_data?: boolean
          journal_entry_id: string
          organization_id: string
          original_credit?: number | null
          original_currency?: string | null
          original_debit?: number | null
          sort_order?: number
          tax_rate_id?: string | null
          tax_tag?: string | null
        }
        Update: {
          account_id?: string
          analytic_account_id?: string | null
          branch_id?: string | null
          business_id?: string
          contact_id?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description?: string | null
          exchange_rate?: number | null
          id?: string
          is_sample_data?: boolean
          journal_entry_id?: string
          organization_id?: string
          original_credit?: number | null
          original_currency?: string | null
          original_debit?: number | null
          sort_order?: number
          tax_rate_id?: string | null
          tax_tag?: string | null
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
            foreignKeyName: "journal_entry_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_analytic_account_id_fkey"
            columns: ["analytic_account_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
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
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "journal_entry_lines_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_tax_rate_id_fkey"
            columns: ["tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_recipient_types: {
        Row: {
          code: string
          created_at: string
          default_always_first: boolean
          default_cap_exempt: boolean
          default_statement_cadence: string | null
          description: string | null
          id: string
          is_active: boolean
          is_government: boolean
          label: string
          metadata: Json
          organization_id: string | null
          source_pack_id: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          default_always_first?: boolean
          default_cap_exempt?: boolean
          default_statement_cadence?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_government?: boolean
          label: string
          metadata?: Json
          organization_id?: string | null
          source_pack_id?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          default_always_first?: boolean
          default_cap_exempt?: boolean
          default_statement_cadence?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          is_government?: boolean
          label?: string
          metadata?: Json
          organization_id?: string | null
          source_pack_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_recipient_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "legal_recipient_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "legal_recipient_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_recipients: {
        Row: {
          address: string | null
          aggregate_cap_exempt: boolean
          always_first: boolean
          authority_id: string | null
          contact_email: string | null
          contact_id: string | null
          contact_phone: string | null
          created_at: string
          created_by: string | null
          default_payee_account: string | null
          default_payee_bank: string | null
          default_payee_reference_template: string | null
          default_payment_method_id: string | null
          display_name: string
          id: string
          is_active: boolean
          jurisdiction_country: string | null
          jurisdiction_region: string | null
          metadata: Json
          organization_id: string
          recipient_type_code: string
          remittance_schedule_ref: string | null
          statement_cadence: string | null
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          aggregate_cap_exempt?: boolean
          always_first?: boolean
          authority_id?: string | null
          contact_email?: string | null
          contact_id?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          default_payee_account?: string | null
          default_payee_bank?: string | null
          default_payee_reference_template?: string | null
          default_payment_method_id?: string | null
          display_name: string
          id?: string
          is_active?: boolean
          jurisdiction_country?: string | null
          jurisdiction_region?: string | null
          metadata?: Json
          organization_id: string
          recipient_type_code: string
          remittance_schedule_ref?: string | null
          statement_cadence?: string | null
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          aggregate_cap_exempt?: boolean
          always_first?: boolean
          authority_id?: string | null
          contact_email?: string | null
          contact_id?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          default_payee_account?: string | null
          default_payee_bank?: string | null
          default_payee_reference_template?: string | null
          default_payment_method_id?: string | null
          display_name?: string
          id?: string
          is_active?: boolean
          jurisdiction_country?: string | null
          jurisdiction_region?: string | null
          metadata?: Json
          organization_id?: string
          recipient_type_code?: string
          remittance_schedule_ref?: string | null
          statement_cadence?: string | null
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_recipients_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_recipients_default_payment_method_id_fkey"
            columns: ["default_payment_method_id"]
            isOneToOne: false
            referencedRelation: "organization_payment_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legal_recipients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "legal_recipients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "legal_recipients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_lifecycle_events: {
        Row: {
          actor_user_id: string | null
          amount: number | null
          cosigner_user_id: string | null
          created_at: string
          event_type: string
          id: string
          loan_id: string
          new_status: string | null
          organization_id: string
          payload: Json
          prior_status: string | null
          reason: string | null
        }
        Insert: {
          actor_user_id?: string | null
          amount?: number | null
          cosigner_user_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          loan_id: string
          new_status?: string | null
          organization_id: string
          payload?: Json
          prior_status?: string | null
          reason?: string | null
        }
        Update: {
          actor_user_id?: string | null
          amount?: number | null
          cosigner_user_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          loan_id?: string
          new_status?: string | null
          organization_id?: string
          payload?: Json
          prior_status?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loan_lifecycle_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "loan_lifecycle_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "loan_lifecycle_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_skip_override_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          event_type: string
          id: string
          new_status: string | null
          organization_id: string
          override_id: string
          payload: Json
          prior_status: string | null
          reason: string | null
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          new_status?: string | null
          organization_id: string
          override_id: string
          payload?: Json
          prior_status?: string | null
          reason?: string | null
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          new_status?: string | null
          organization_id?: string
          override_id?: string
          payload?: Json
          prior_status?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loan_skip_override_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "loan_skip_override_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "loan_skip_override_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_types: {
        Row: {
          allow_restructure: boolean
          allow_skip: boolean
          allow_topup: boolean
          business_id: string | null
          clearing_account_id: string | null
          code: string
          created_at: string
          deduction_priority: number
          default_installments: number | null
          default_max_pct_of_net: number | null
          default_min_net_pay_floor: number | null
          default_repayment_method: string
          description: string | null
          dual_control_writeoff: boolean
          dynamic_field_schema: Json
          gl_disbursement_clearing_account_id: string | null
          gl_receivable_account_id: string | null
          id: string
          interest_income_account_id: string | null
          interest_method: string
          interest_treatment_on_skip: string
          is_active: boolean
          kind: string
          max_exposure_pct_of_net: number | null
          max_installments: number | null
          max_principal: number | null
          max_skips_per_calendar_year: number | null
          max_skips_per_loan: number | null
          max_tenure_months: number | null
          min_gap_between_skips_days: number
          min_installments: number | null
          min_principal: number | null
          min_tenure_months: number | null
          name: string
          organization_id: string
          requires_approval: boolean
          requires_collateral: boolean
          requires_consent: boolean
          requires_dual_approval: boolean
          requires_interest: boolean
          requires_schedule: boolean
          salary_rule_code: string | null
          schedule_adjustment_on_skip: string
          updated_at: string
          writeoff_account_id: string | null
        }
        Insert: {
          allow_restructure?: boolean
          allow_skip?: boolean
          allow_topup?: boolean
          business_id?: string | null
          clearing_account_id?: string | null
          code: string
          created_at?: string
          deduction_priority?: number
          default_installments?: number | null
          default_max_pct_of_net?: number | null
          default_min_net_pay_floor?: number | null
          default_repayment_method?: string
          description?: string | null
          dual_control_writeoff?: boolean
          dynamic_field_schema?: Json
          gl_disbursement_clearing_account_id?: string | null
          gl_receivable_account_id?: string | null
          id?: string
          interest_income_account_id?: string | null
          interest_method?: string
          interest_treatment_on_skip?: string
          is_active?: boolean
          kind?: string
          max_exposure_pct_of_net?: number | null
          max_installments?: number | null
          max_principal?: number | null
          max_skips_per_calendar_year?: number | null
          max_skips_per_loan?: number | null
          max_tenure_months?: number | null
          min_gap_between_skips_days?: number
          min_installments?: number | null
          min_principal?: number | null
          min_tenure_months?: number | null
          name: string
          organization_id: string
          requires_approval?: boolean
          requires_collateral?: boolean
          requires_consent?: boolean
          requires_dual_approval?: boolean
          requires_interest?: boolean
          requires_schedule?: boolean
          salary_rule_code?: string | null
          schedule_adjustment_on_skip?: string
          updated_at?: string
          writeoff_account_id?: string | null
        }
        Update: {
          allow_restructure?: boolean
          allow_skip?: boolean
          allow_topup?: boolean
          business_id?: string | null
          clearing_account_id?: string | null
          code?: string
          created_at?: string
          deduction_priority?: number
          default_installments?: number | null
          default_max_pct_of_net?: number | null
          default_min_net_pay_floor?: number | null
          default_repayment_method?: string
          description?: string | null
          dual_control_writeoff?: boolean
          dynamic_field_schema?: Json
          gl_disbursement_clearing_account_id?: string | null
          gl_receivable_account_id?: string | null
          id?: string
          interest_income_account_id?: string | null
          interest_method?: string
          interest_treatment_on_skip?: string
          is_active?: boolean
          kind?: string
          max_exposure_pct_of_net?: number | null
          max_installments?: number | null
          max_principal?: number | null
          max_skips_per_calendar_year?: number | null
          max_skips_per_loan?: number | null
          max_tenure_months?: number | null
          min_gap_between_skips_days?: number
          min_installments?: number | null
          min_principal?: number | null
          min_tenure_months?: number | null
          name?: string
          organization_id?: string
          requires_approval?: boolean
          requires_collateral?: boolean
          requires_consent?: boolean
          requires_dual_approval?: boolean
          requires_interest?: boolean
          requires_schedule?: boolean
          salary_rule_code?: string | null
          schedule_adjustment_on_skip?: string
          updated_at?: string
          writeoff_account_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loan_types_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_clearing_account_id_fkey"
            columns: ["clearing_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_clearing_account_id_fkey"
            columns: ["clearing_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_interest_income_account_id_fkey"
            columns: ["interest_income_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_interest_income_account_id_fkey"
            columns: ["interest_income_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "loan_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "loan_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_writeoff_account_id_fkey"
            columns: ["writeoff_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_types_writeoff_account_id_fkey"
            columns: ["writeoff_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      login_history: {
        Row: {
          alert_sent: boolean
          alert_sent_at: string | null
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          device_fingerprint: string | null
          device_id: string | null
          email: string | null
          failure_reason: string | null
          id: string
          ip_address: unknown
          is_new_device: boolean
          is_new_location: boolean
          login_method: string
          region: string | null
          risk_score: number | null
          status: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          alert_sent?: boolean
          alert_sent_at?: string | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          device_fingerprint?: string | null
          device_id?: string | null
          email?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: unknown
          is_new_device?: boolean
          is_new_location?: boolean
          login_method: string
          region?: string | null
          risk_score?: number | null
          status: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          alert_sent?: boolean
          alert_sent_at?: string | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          device_fingerprint?: string | null
          device_id?: string | null
          email?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: unknown
          is_new_device?: boolean
          is_new_location?: boolean
          login_method?: string
          region?: string | null
          risk_score?: number | null
          status?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "login_history_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "user_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      media_profiles: {
        Row: {
          active: boolean
          business_id: string | null
          code: string | null
          created_at: string
          created_by: string | null
          dpi: number | null
          gap_mm: number | null
          height_mm: number | null
          id: string
          is_default: boolean
          kind: string | null
          name: string
          org_id: string
          orientation: string | null
          updated_at: string
          width_mm: number
        }
        Insert: {
          active?: boolean
          business_id?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          dpi?: number | null
          gap_mm?: number | null
          height_mm?: number | null
          id?: string
          is_default?: boolean
          kind?: string | null
          name: string
          org_id: string
          orientation?: string | null
          updated_at?: string
          width_mm: number
        }
        Update: {
          active?: boolean
          business_id?: string | null
          code?: string | null
          created_at?: string
          created_by?: string | null
          dpi?: number | null
          gap_mm?: number | null
          height_mm?: number | null
          id?: string
          is_default?: boolean
          kind?: string | null
          name?: string
          org_id?: string
          orientation?: string | null
          updated_at?: string
          width_mm?: number
        }
        Relationships: [
          {
            foreignKeyName: "media_profiles_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "media_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "media_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      member_permission_groups: {
        Row: {
          branch_scope: Database["public"]["Enums"]["branch_scope_mode"]
          created_at: string
          id: string
          organization_id: string
          permission_group_id: string
          user_id: string
        }
        Insert: {
          branch_scope?: Database["public"]["Enums"]["branch_scope_mode"]
          created_at?: string
          id?: string
          organization_id: string
          permission_group_id: string
          user_id: string
        }
        Update: {
          branch_scope?: Database["public"]["Enums"]["branch_scope_mode"]
          created_at?: string
          id?: string
          organization_id?: string
          permission_group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "member_permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "member_permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_permission_groups_permission_group_id_fkey"
            columns: ["permission_group_id"]
            isOneToOne: false
            referencedRelation: "permission_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_account_mapping_audit: {
        Row: {
          action: string
          branch_id: string | null
          business_id: string | null
          changed_by: string | null
          created_at: string
          id: string
          mapping_key: string
          new_account_id: string | null
          notes: string | null
          old_account_id: string | null
        }
        Insert: {
          action: string
          branch_id?: string | null
          business_id?: string | null
          changed_by?: string | null
          created_at?: string
          id?: string
          mapping_key: string
          new_account_id?: string | null
          notes?: string | null
          old_account_id?: string | null
        }
        Update: {
          action?: string
          branch_id?: string | null
          business_id?: string | null
          changed_by?: string | null
          created_at?: string
          id?: string
          mapping_key?: string
          new_account_id?: string | null
          notes?: string | null
          old_account_id?: string | null
        }
        Relationships: []
      }
      mf_account_mappings: {
        Row: {
          account_id: string
          branch_id: string | null
          business_id: string
          created_at: string
          id: string
          mapping_key: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          account_id: string
          branch_id?: string | null
          business_id: string
          created_at?: string
          id?: string
          mapping_key: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          branch_id?: string | null
          business_id?: string
          created_at?: string
          id?: string
          mapping_key?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_account_mappings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_account_mappings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_account_mappings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_account_mappings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_allocation_policy: {
        Row: {
          allocation_order: string[]
          allow_overpayment: boolean
          business_id: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          allocation_order?: string[]
          allow_overpayment?: boolean
          business_id: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          allocation_order?: string[]
          allow_overpayment?: boolean
          business_id?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      mf_application_assessments: {
        Row: {
          application_id: string
          assessed_at: string
          assessed_by: string
          business_id: string
          business_verified: boolean
          character_notes: string | null
          collateral_description: string | null
          created_at: string
          existing_obligations: number
          id: string
          monthly_expenses: number
          monthly_income: number
          notes: string | null
          recommendation: string
          recommended_amount: number | null
          recommended_term_installments: number | null
          updated_at: string
          visit_date: string
          visit_location: string | null
        }
        Insert: {
          application_id: string
          assessed_at?: string
          assessed_by: string
          business_id: string
          business_verified?: boolean
          character_notes?: string | null
          collateral_description?: string | null
          created_at?: string
          existing_obligations?: number
          id?: string
          monthly_expenses?: number
          monthly_income?: number
          notes?: string | null
          recommendation?: string
          recommended_amount?: number | null
          recommended_term_installments?: number | null
          updated_at?: string
          visit_date?: string
          visit_location?: string | null
        }
        Update: {
          application_id?: string
          assessed_at?: string
          assessed_by?: string
          business_id?: string
          business_verified?: boolean
          character_notes?: string | null
          collateral_description?: string | null
          created_at?: string
          existing_obligations?: number
          id?: string
          monthly_expenses?: number
          monthly_income?: number
          notes?: string | null
          recommendation?: string
          recommended_amount?: number | null
          recommended_term_installments?: number | null
          updated_at?: string
          visit_date?: string
          visit_location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_application_assessments_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_application_assessments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_client_charges: {
        Row: {
          amount: number
          branch_id: string
          business_id: string
          charged_on: string
          client_id: string
          created_at: string
          created_by: string | null
          currency_code: string
          id: string
          journal_entry_id: string | null
          kind: string
          method: string | null
          notes: string | null
          paid_on: string | null
          receipt_number: string | null
          reference: string | null
          reversal_journal_entry_id: string | null
          reversal_reason: string | null
          reversed_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          branch_id: string
          business_id: string
          charged_on?: string
          client_id: string
          created_at?: string
          created_by?: string | null
          currency_code: string
          id?: string
          journal_entry_id?: string | null
          kind?: string
          method?: string | null
          notes?: string | null
          paid_on?: string | null
          receipt_number?: string | null
          reference?: string | null
          reversal_journal_entry_id?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          branch_id?: string
          business_id?: string
          charged_on?: string
          client_id?: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          id?: string
          journal_entry_id?: string | null
          kind?: string
          method?: string | null
          notes?: string | null
          paid_on?: string | null
          receipt_number?: string | null
          reference?: string | null
          reversal_journal_entry_id?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_client_charges_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_client_charges_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_client_charges_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_client_charges_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "mf_client_charges_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_client_charges_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_client_charges_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "mf_client_charges_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_client_charges_reversal_journal_entry_id_fkey"
            columns: ["reversal_journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_client_fee_policy: {
        Row: {
          admission_fee_active: boolean
          admission_fee_amount: number | null
          admission_fee_currency: string | null
          business_id: string
          created_at: string
          id: string
          updated_at: string
        }
        Insert: {
          admission_fee_active?: boolean
          admission_fee_amount?: number | null
          admission_fee_currency?: string | null
          business_id: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Update: {
          admission_fee_active?: boolean
          admission_fee_amount?: number | null
          admission_fee_currency?: string | null
          business_id?: string
          created_at?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      mf_clients: {
        Row: {
          branch_id: string
          business_id: string
          business_location: string | null
          business_type: string | null
          client_number: string
          completed_cycles: number
          created_at: string
          created_by: string | null
          date_of_birth: string | null
          email: string | null
          full_name: string
          gender: string | null
          id: string
          id_back_path: string | null
          id_front_path: string | null
          joined_on: string
          kin_id_back_path: string | null
          kin_id_front_path: string | null
          loan_officer_id: string | null
          national_id: string | null
          next_of_kin_name: string | null
          next_of_kin_phone: string | null
          next_of_kin_relationship: string | null
          notes: string | null
          occupation: string | null
          phone: string | null
          photo_path: string | null
          photo_url: string | null
          physical_address: string | null
          status: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          business_id: string
          business_location?: string | null
          business_type?: string | null
          client_number: string
          completed_cycles?: number
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          email?: string | null
          full_name: string
          gender?: string | null
          id?: string
          id_back_path?: string | null
          id_front_path?: string | null
          joined_on?: string
          kin_id_back_path?: string | null
          kin_id_front_path?: string | null
          loan_officer_id?: string | null
          national_id?: string | null
          next_of_kin_name?: string | null
          next_of_kin_phone?: string | null
          next_of_kin_relationship?: string | null
          notes?: string | null
          occupation?: string | null
          phone?: string | null
          photo_path?: string | null
          photo_url?: string | null
          physical_address?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          business_id?: string
          business_location?: string | null
          business_type?: string | null
          client_number?: string
          completed_cycles?: number
          created_at?: string
          created_by?: string | null
          date_of_birth?: string | null
          email?: string | null
          full_name?: string
          gender?: string | null
          id?: string
          id_back_path?: string | null
          id_front_path?: string | null
          joined_on?: string
          kin_id_back_path?: string | null
          kin_id_front_path?: string | null
          loan_officer_id?: string | null
          national_id?: string | null
          next_of_kin_name?: string | null
          next_of_kin_phone?: string | null
          next_of_kin_relationship?: string | null
          notes?: string | null
          occupation?: string | null
          phone?: string | null
          photo_path?: string | null
          photo_url?: string | null
          physical_address?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_clients_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_clients_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_collection_activities: {
        Row: {
          activity_at: string
          activity_type: string
          amount_collected: number | null
          branch_id: string | null
          business_id: string
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string
          created_at: string
          created_by: string
          id: string
          loan_id: string
          notes: string | null
          officer_id: string
          outcome: string | null
          promise_amount: number | null
          promise_date: string | null
          updated_at: string
        }
        Insert: {
          activity_at?: string
          activity_type: string
          amount_collected?: number | null
          branch_id?: string | null
          business_id: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id: string
          created_at?: string
          created_by?: string
          id?: string
          loan_id: string
          notes?: string | null
          officer_id?: string
          outcome?: string | null
          promise_amount?: number | null
          promise_date?: string | null
          updated_at?: string
        }
        Update: {
          activity_at?: string
          activity_type?: string
          amount_collected?: number | null
          branch_id?: string | null
          business_id?: string
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string
          created_at?: string
          created_by?: string
          id?: string
          loan_id?: string
          notes?: string | null
          officer_id?: string
          outcome?: string | null
          promise_amount?: number | null
          promise_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_collection_activities_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_activities_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_activities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_collection_activities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_activities_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_collection_activities_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_collection_bankings: {
        Row: {
          amount: number
          bank_account_id: string
          bank_transaction_id: string | null
          banked_by: string | null
          banked_on: string
          batch_id: string
          branch_id: string | null
          business_id: string
          cash_amount: number
          created_at: string
          id: string
          journal_entry_id: string | null
          mobile_money_amount: number
          notes: string | null
          reference: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          bank_account_id: string
          bank_transaction_id?: string | null
          banked_by?: string | null
          banked_on: string
          batch_id: string
          branch_id?: string | null
          business_id: string
          cash_amount?: number
          created_at?: string
          id?: string
          journal_entry_id?: string | null
          mobile_money_amount?: number
          notes?: string | null
          reference?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_account_id?: string
          bank_transaction_id?: string | null
          banked_by?: string | null
          banked_on?: string
          batch_id?: string
          branch_id?: string | null
          business_id?: string
          cash_amount?: number
          created_at?: string
          id?: string
          journal_entry_id?: string | null
          mobile_money_amount?: number
          notes?: string | null
          reference?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_collection_bankings_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_bank_transaction_id_fkey"
            columns: ["bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: true
            referencedRelation: "mf_repayment_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_collection_bankings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_event_postings: {
        Row: {
          business_id: string
          created_at: string
          id: string
          journal_entry_id: string
          loan_event_id: string
          posting_kind: string
        }
        Insert: {
          business_id: string
          created_at?: string
          id?: string
          journal_entry_id: string
          loan_event_id: string
          posting_kind?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          id?: string
          journal_entry_id?: string
          loan_event_id?: string
          posting_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_event_postings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "mf_event_postings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_event_postings_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_event_postings_loan_event_id_fkey"
            columns: ["loan_event_id"]
            isOneToOne: true
            referencedRelation: "mf_loan_events"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_group_members: {
        Row: {
          business_id: string
          client_id: string
          created_at: string
          exited_on: string | null
          group_id: string
          id: string
          is_active: boolean
          joined_on: string
          role_in_group: string
          updated_at: string
        }
        Insert: {
          business_id: string
          client_id: string
          created_at?: string
          exited_on?: string | null
          group_id: string
          id?: string
          is_active?: boolean
          joined_on?: string
          role_in_group?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          client_id?: string
          created_at?: string
          exited_on?: string | null
          group_id?: string
          id?: string
          is_active?: boolean
          joined_on?: string
          role_in_group?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_group_members_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_group_members_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_group_members_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "mf_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_groups: {
        Row: {
          branch_id: string
          business_id: string
          created_at: string
          created_by: string | null
          formed_on: string
          group_number: string
          id: string
          loan_officer_id: string | null
          meeting_day: number | null
          meeting_place: string | null
          meeting_time: string | null
          name: string
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          branch_id: string
          business_id: string
          created_at?: string
          created_by?: string | null
          formed_on?: string
          group_number: string
          id?: string
          loan_officer_id?: string | null
          meeting_day?: number | null
          meeting_place?: string | null
          meeting_time?: string | null
          name: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          branch_id?: string
          business_id?: string
          created_at?: string
          created_by?: string | null
          formed_on?: string
          group_number?: string
          id?: string
          loan_officer_id?: string | null
          meeting_day?: number | null
          meeting_place?: string | null
          meeting_time?: string | null
          name?: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_groups_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_groups_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_applications: {
        Row: {
          application_number: string
          approved_amount: number | null
          approved_term_installments: number | null
          branch_id: string
          business_id: string
          client_id: string
          created_at: string
          created_by: string | null
          decision_at: string | null
          decision_by: string | null
          decision_notes: string | null
          group_id: string | null
          id: string
          loan_officer_id: string | null
          product_id: string
          product_version_id: string | null
          purpose: string | null
          rejection_reason: string | null
          requested_amount: number
          requested_term_installments: number
          review_started_at: string | null
          status: string
          submitted_at: string | null
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          application_number: string
          approved_amount?: number | null
          approved_term_installments?: number | null
          branch_id: string
          business_id: string
          client_id: string
          created_at?: string
          created_by?: string | null
          decision_at?: string | null
          decision_by?: string | null
          decision_notes?: string | null
          group_id?: string | null
          id?: string
          loan_officer_id?: string | null
          product_id: string
          product_version_id?: string | null
          purpose?: string | null
          rejection_reason?: string | null
          requested_amount: number
          requested_term_installments: number
          review_started_at?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          application_number?: string
          approved_amount?: number | null
          approved_term_installments?: number | null
          branch_id?: string
          business_id?: string
          client_id?: string
          created_at?: string
          created_by?: string | null
          decision_at?: string | null
          decision_by?: string | null
          decision_notes?: string | null
          group_id?: string | null
          id?: string
          loan_officer_id?: string | null
          product_id?: string
          product_version_id?: string | null
          purpose?: string | null
          rejection_reason?: string | null
          requested_amount?: number
          requested_term_installments?: number
          review_started_at?: string | null
          status?: string
          submitted_at?: string | null
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_applications_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_applications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_loan_applications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_applications_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "mf_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_applications_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_applications_product_version_id_fkey"
            columns: ["product_version_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_product_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_charges: {
        Row: {
          accrual_key: string | null
          amount: number
          branch_id: string | null
          business_id: string
          charged_on: string
          created_at: string
          created_by: string | null
          id: string
          installment_no: number
          kind: string
          loan_id: string
          reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          accrual_key?: string | null
          amount: number
          branch_id?: string | null
          business_id: string
          charged_on?: string
          created_at?: string
          created_by?: string | null
          id?: string
          installment_no: number
          kind?: string
          loan_id: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          accrual_key?: string | null
          amount?: number
          branch_id?: string | null
          business_id?: string
          charged_on?: string
          created_at?: string
          created_by?: string | null
          id?: string
          installment_no?: number
          kind?: string
          loan_id?: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_charges_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_charges_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_disbursements: {
        Row: {
          amount: number
          bank_transaction_id: string | null
          business_id: string
          created_at: string
          disbursed_by: string | null
          disbursed_on: string
          fee_breakdown: Json
          fees_deducted: number
          id: string
          loan_id: string
          method: string
          net_amount: number | null
          notes: string | null
          received_by_name: string | null
          reference: string | null
          reversal_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
          source_account_id: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          bank_transaction_id?: string | null
          business_id: string
          created_at?: string
          disbursed_by?: string | null
          disbursed_on: string
          fee_breakdown?: Json
          fees_deducted?: number
          id?: string
          loan_id: string
          method: string
          net_amount?: number | null
          notes?: string | null
          received_by_name?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          source_account_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_transaction_id?: string | null
          business_id?: string
          created_at?: string
          disbursed_by?: string | null
          disbursed_on?: string
          fee_breakdown?: Json
          fees_deducted?: number
          id?: string
          loan_id?: string
          method?: string
          net_amount?: number | null
          notes?: string | null
          received_by_name?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          source_account_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_disbursements_bank_transaction_id_fkey"
            columns: ["bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_disbursements_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_disbursements_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_events: {
        Row: {
          actor_id: string | null
          amount: number | null
          business_id: string
          created_at: string
          event_at: string
          event_type: string
          id: string
          loan_id: string
          payload: Json
        }
        Insert: {
          actor_id?: string | null
          amount?: number | null
          business_id: string
          created_at?: string
          event_at?: string
          event_type: string
          id?: string
          loan_id: string
          payload?: Json
        }
        Update: {
          actor_id?: string | null
          amount?: number | null
          business_id?: string
          created_at?: string
          event_at?: string
          event_type?: string
          id?: string
          loan_id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_events_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_events_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_product_versions: {
        Row: {
          business_id: string
          created_at: string
          created_by: string | null
          currency_code: string
          effective_from: string
          eligibility: Json
          fees: Json
          grace_period_installments: number
          id: string
          interest_method: string
          interest_rate: number
          interest_rate_period: string
          is_published: boolean
          max_amount: number
          max_term_installments: number
          min_amount: number
          min_term_installments: number
          penalty_basis: string
          penalty_rate: number
          product_id: string
          published_at: string | null
          repayment_frequency: string
          updated_at: string
          version_no: number
        }
        Insert: {
          business_id: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          effective_from?: string
          eligibility?: Json
          fees?: Json
          grace_period_installments?: number
          id?: string
          interest_method: string
          interest_rate: number
          interest_rate_period?: string
          is_published?: boolean
          max_amount: number
          max_term_installments: number
          min_amount: number
          min_term_installments: number
          penalty_basis?: string
          penalty_rate?: number
          product_id: string
          published_at?: string | null
          repayment_frequency: string
          updated_at?: string
          version_no: number
        }
        Update: {
          business_id?: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          effective_from?: string
          eligibility?: Json
          fees?: Json
          grace_period_installments?: number
          id?: string
          interest_method?: string
          interest_rate?: number
          interest_rate_period?: string
          is_published?: boolean
          max_amount?: number
          max_term_installments?: number
          min_amount?: number
          min_term_installments?: number
          penalty_basis?: string
          penalty_rate?: number
          product_id?: string
          published_at?: string | null
          repayment_frequency?: string
          updated_at?: string
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_product_versions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_product_versions_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_products"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_products: {
        Row: {
          business_id: string
          code: string
          created_at: string
          created_by: string | null
          current_version_id: string | null
          description: string | null
          id: string
          name: string
          status: string
          updated_at: string
        }
        Insert: {
          business_id: string
          code: string
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          id?: string
          name: string
          status?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          code?: string
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          description?: string | null
          id?: string
          name?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_products_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loan_products_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_product_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_schedule: {
        Row: {
          business_id: string
          closing_balance: number
          created_at: string
          due_date: string
          fees_due: number
          id: string
          installment_no: number
          interest_due: number
          is_grace: boolean
          loan_id: string
          opening_balance: number
          principal_due: number
          total_due: number
          updated_at: string
        }
        Insert: {
          business_id: string
          closing_balance?: number
          created_at?: string
          due_date: string
          fees_due?: number
          id?: string
          installment_no: number
          interest_due?: number
          is_grace?: boolean
          loan_id: string
          opening_balance?: number
          principal_due?: number
          total_due?: number
          updated_at?: string
        }
        Update: {
          business_id?: string
          closing_balance?: number
          created_at?: string
          due_date?: string
          fees_due?: number
          id?: string
          installment_no?: number
          interest_due?: number
          is_grace?: boolean
          loan_id?: string
          opening_balance?: number
          principal_due?: number
          total_due?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loans: {
        Row: {
          application_id: string | null
          branch_id: string | null
          business_id: string
          client_id: string
          closed_at: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          disbursed_at: string | null
          expected_disbursement_date: string | null
          fees: Json
          first_installment_date: string | null
          grace_period_installments: number
          group_id: string | null
          id: string
          interest_method: string
          interest_rate: number
          interest_rate_period: string
          lineage_kind: string
          loan_number: string
          loan_officer_id: string | null
          parent_loan_id: string | null
          penalty_basis: string | null
          penalty_rate: number
          principal: number
          product_id: string
          product_version_id: string
          repayment_frequency: string
          settled_by_loan_id: string | null
          status: string
          term_installments: number
          updated_at: string
        }
        Insert: {
          application_id?: string | null
          branch_id?: string | null
          business_id: string
          client_id: string
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency_code: string
          disbursed_at?: string | null
          expected_disbursement_date?: string | null
          fees?: Json
          first_installment_date?: string | null
          grace_period_installments?: number
          group_id?: string | null
          id?: string
          interest_method: string
          interest_rate?: number
          interest_rate_period: string
          lineage_kind?: string
          loan_number: string
          loan_officer_id?: string | null
          parent_loan_id?: string | null
          penalty_basis?: string | null
          penalty_rate?: number
          principal: number
          product_id: string
          product_version_id: string
          repayment_frequency: string
          settled_by_loan_id?: string | null
          status?: string
          term_installments: number
          updated_at?: string
        }
        Update: {
          application_id?: string | null
          branch_id?: string | null
          business_id?: string
          client_id?: string
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          disbursed_at?: string | null
          expected_disbursement_date?: string | null
          fees?: Json
          first_installment_date?: string | null
          grace_period_installments?: number
          group_id?: string | null
          id?: string
          interest_method?: string
          interest_rate?: number
          interest_rate_period?: string
          lineage_kind?: string
          loan_number?: string
          loan_officer_id?: string | null
          parent_loan_id?: string | null
          penalty_basis?: string | null
          penalty_rate?: number
          principal?: number
          product_id?: string
          product_version_id?: string
          repayment_frequency?: string
          settled_by_loan_id?: string | null
          status?: string
          term_installments?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_loans_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: true
            referencedRelation: "mf_loan_applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "mf_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_parent_loan_id_fkey"
            columns: ["parent_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loans_parent_loan_id_fkey"
            columns: ["parent_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_product_version_id_fkey"
            columns: ["product_version_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_product_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_settled_by_loan_id_fkey"
            columns: ["settled_by_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loans_settled_by_loan_id_fkey"
            columns: ["settled_by_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_repayment_allocations: {
        Row: {
          amount: number
          business_id: string
          component: string
          created_at: string
          id: string
          installment_no: number | null
          loan_id: string
          repayment_id: string
        }
        Insert: {
          amount: number
          business_id: string
          component: string
          created_at?: string
          id?: string
          installment_no?: number | null
          loan_id: string
          repayment_id: string
        }
        Update: {
          amount?: number
          business_id?: string
          component?: string
          created_at?: string
          id?: string
          installment_no?: number | null
          loan_id?: string
          repayment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_repayment_allocations_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_repayment_allocations_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_repayment_allocations_repayment_id_fkey"
            columns: ["repayment_id"]
            isOneToOne: false
            referencedRelation: "mf_repayments"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_repayment_batches: {
        Row: {
          batch_number: string
          branch_id: string | null
          business_id: string
          collected_by: string | null
          collected_on: string
          created_at: string
          created_by: string | null
          group_id: string | null
          id: string
          notes: string | null
          status: string
          updated_at: string
        }
        Insert: {
          batch_number: string
          branch_id?: string | null
          business_id: string
          collected_by?: string | null
          collected_on?: string
          created_at?: string
          created_by?: string | null
          group_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          batch_number?: string
          branch_id?: string | null
          business_id?: string
          collected_by?: string | null
          collected_on?: string
          created_at?: string
          created_by?: string | null
          group_id?: string | null
          id?: string
          notes?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_repayment_batches_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "mf_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_repayments: {
        Row: {
          amount: number
          batch_id: string | null
          branch_id: string | null
          business_id: string
          client_id: string
          created_at: string
          created_by: string | null
          id: string
          loan_id: string
          method: string
          notes: string | null
          paid_on: string
          receipt_number: string
          received_by: string | null
          reference: string | null
          reversal_reason: string | null
          reversed_at: string | null
          reversed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          batch_id?: string | null
          branch_id?: string | null
          business_id: string
          client_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          loan_id: string
          method: string
          notes?: string | null
          paid_on: string
          receipt_number: string
          received_by?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          batch_id?: string | null
          branch_id?: string | null
          business_id?: string
          client_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          loan_id?: string
          method?: string
          notes?: string | null
          paid_on?: string
          receipt_number?: string
          received_by?: string | null
          reference?: string | null
          reversal_reason?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mf_repayments_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mf_repayment_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_repayments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_repayments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_repayments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_repayments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_batches: {
        Row: {
          batch_hash: string
          created_at: string
          error_details: Json | null
          id: string
          records_failed: number | null
          records_imported: number | null
          records_total: number | null
          session_id: string
          source_file_name: string | null
          step_key: string
        }
        Insert: {
          batch_hash: string
          created_at?: string
          error_details?: Json | null
          id?: string
          records_failed?: number | null
          records_imported?: number | null
          records_total?: number | null
          session_id: string
          source_file_name?: string | null
          step_key: string
        }
        Update: {
          batch_hash?: string
          created_at?: string
          error_details?: Json | null
          id?: string
          records_failed?: number | null
          records_imported?: number | null
          records_total?: number | null
          session_id?: string
          source_file_name?: string | null
          step_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "migration_batches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "migration_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_sessions: {
        Row: {
          business_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          cutover_date: string | null
          id: string
          migration_strategy: string
          notes: string | null
          organization_id: string
          source_system: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cutover_date?: string | null
          id?: string
          migration_strategy?: string
          notes?: string | null
          organization_id: string
          source_system?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cutover_date?: string | null
          id?: string
          migration_strategy?: string
          notes?: string | null
          organization_id?: string
          source_system?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "migration_sessions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "migration_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "migration_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "migration_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      migration_steps: {
        Row: {
          completed_at: string | null
          created_at: string
          error_count: number | null
          error_log: Json | null
          id: string
          record_count: number | null
          session_id: string
          started_at: string | null
          status: string
          step_key: string
          step_order: number
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_count?: number | null
          error_log?: Json | null
          id?: string
          record_count?: number | null
          session_id: string
          started_at?: string | null
          status?: string
          step_key: string
          step_order: number
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_count?: number | null
          error_log?: Json | null
          id?: string
          record_count?: number | null
          session_id?: string
          started_at?: string | null
          status?: string
          step_key?: string
          step_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "migration_steps_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "migration_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      mpesa_c2b_transactions: {
        Row: {
          bill_ref_number: string | null
          business_id: string | null
          business_short_code: string
          category: string | null
          created_at: string | null
          first_name: string | null
          id: string
          is_reconciled: boolean | null
          last_name: string | null
          match_reason: string | null
          matched_client_id: string | null
          matched_contact_id: string | null
          matched_loan_id: string | null
          matched_repayment_id: string | null
          middle_name: string | null
          msisdn: string | null
          org_account_balance: number | null
          organization_id: string
          raw_payload: Json | null
          reconciled_at: string | null
          reconciled_by: string | null
          third_party_trans_id: string | null
          trans_amount: number
          trans_id: string
          trans_time: string
          transaction_type: string
          updated_at: string | null
        }
        Insert: {
          bill_ref_number?: string | null
          business_id?: string | null
          business_short_code: string
          category?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string
          is_reconciled?: boolean | null
          last_name?: string | null
          match_reason?: string | null
          matched_client_id?: string | null
          matched_contact_id?: string | null
          matched_loan_id?: string | null
          matched_repayment_id?: string | null
          middle_name?: string | null
          msisdn?: string | null
          org_account_balance?: number | null
          organization_id: string
          raw_payload?: Json | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          third_party_trans_id?: string | null
          trans_amount: number
          trans_id: string
          trans_time: string
          transaction_type: string
          updated_at?: string | null
        }
        Update: {
          bill_ref_number?: string | null
          business_id?: string | null
          business_short_code?: string
          category?: string | null
          created_at?: string | null
          first_name?: string | null
          id?: string
          is_reconciled?: boolean | null
          last_name?: string | null
          match_reason?: string | null
          matched_client_id?: string | null
          matched_contact_id?: string | null
          matched_loan_id?: string | null
          matched_repayment_id?: string | null
          middle_name?: string | null
          msisdn?: string | null
          org_account_balance?: number | null
          organization_id?: string
          raw_payload?: Json | null
          reconciled_at?: string | null
          reconciled_by?: string | null
          third_party_trans_id?: string | null
          trans_amount?: number
          trans_id?: string
          trans_time?: string
          transaction_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mpesa_c2b_transactions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_client_id_fkey"
            columns: ["matched_client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_client_id_fkey"
            columns: ["matched_client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_contact_id_fkey"
            columns: ["matched_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_loan_id_fkey"
            columns: ["matched_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_loan_id_fkey"
            columns: ["matched_loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_matched_repayment_id_fkey"
            columns: ["matched_repayment_id"]
            isOneToOne: false
            referencedRelation: "mf_repayments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "mpesa_c2b_transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_alert_settings: {
        Row: {
          business_id: string | null
          created_at: string | null
          daily_digest_enabled: boolean | null
          digest_send_hour: number | null
          digest_timezone: string | null
          expense_approval_required_above: number | null
          finance_alert_missing_je_enabled: boolean
          id: string
          large_payment_threshold: number | null
          organization_id: string
          overdue_escalation_enabled: boolean | null
          overdue_reminder_frequency_days: number | null
          payment_received_notify: boolean | null
          updated_at: string | null
          weekly_digest_enabled: boolean | null
        }
        Insert: {
          business_id?: string | null
          created_at?: string | null
          daily_digest_enabled?: boolean | null
          digest_send_hour?: number | null
          digest_timezone?: string | null
          expense_approval_required_above?: number | null
          finance_alert_missing_je_enabled?: boolean
          id?: string
          large_payment_threshold?: number | null
          organization_id: string
          overdue_escalation_enabled?: boolean | null
          overdue_reminder_frequency_days?: number | null
          payment_received_notify?: boolean | null
          updated_at?: string | null
          weekly_digest_enabled?: boolean | null
        }
        Update: {
          business_id?: string | null
          created_at?: string | null
          daily_digest_enabled?: boolean | null
          digest_send_hour?: number | null
          digest_timezone?: string | null
          expense_approval_required_above?: number | null
          finance_alert_missing_je_enabled?: boolean
          id?: string
          large_payment_threshold?: number | null
          organization_id?: string
          overdue_escalation_enabled?: boolean | null
          overdue_reminder_frequency_days?: number | null
          payment_received_notify?: boolean | null
          updated_at?: string | null
          weekly_digest_enabled?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_alert_settings_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_alert_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notification_alert_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "notification_alert_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_delivery_log: {
        Row: {
          business_id: string | null
          category: string
          channel: string
          created_at: string
          detail: Json | null
          entity_id: string | null
          entity_type: string | null
          event: string
          id: string
          organization_id: string
          status: string
          suppressed_reason: string | null
          user_id: string
        }
        Insert: {
          business_id?: string | null
          category: string
          channel: string
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          event: string
          id?: string
          organization_id: string
          status: string
          suppressed_reason?: string | null
          user_id: string
        }
        Update: {
          business_id?: string | null
          category?: string
          channel?: string
          created_at?: string
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          event?: string
          id?: string
          organization_id?: string
          status?: string
          suppressed_reason?: string | null
          user_id?: string
        }
        Relationships: []
      }
      notification_digest_queue: {
        Row: {
          business_id: string | null
          created_at: string | null
          digest_type: string
          id: string
          notification_id: string | null
          organization_id: string
          scheduled_for: string
          sent_at: string | null
          user_id: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string | null
          digest_type?: string
          id?: string
          notification_id?: string | null
          organization_id: string
          scheduled_for: string
          sent_at?: string | null
          user_id: string
        }
        Update: {
          business_id?: string | null
          created_at?: string | null
          digest_type?: string
          id?: string
          notification_id?: string | null
          organization_id?: string
          scheduled_for?: string
          sent_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_digest_queue_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_digest_queue_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_digest_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notification_digest_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "notification_digest_queue_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          business_id: string | null
          category: string
          created_at: string | null
          email_enabled: boolean | null
          id: string
          in_app_enabled: boolean | null
          organization_id: string
          push_enabled: boolean | null
          sms_enabled: boolean | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          business_id?: string | null
          category: string
          created_at?: string | null
          email_enabled?: boolean | null
          id?: string
          in_app_enabled?: boolean | null
          organization_id: string
          push_enabled?: boolean | null
          sms_enabled?: boolean | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          business_id?: string | null
          category?: string
          created_at?: string | null
          email_enabled?: boolean | null
          id?: string
          in_app_enabled?: boolean | null
          organization_id?: string
          push_enabled?: boolean | null
          sms_enabled?: boolean | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_preferences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notification_preferences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "notification_preferences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          business_id: string | null
          category: string
          created_at: string | null
          entity_id: string | null
          entity_type: string | null
          expires_at: string | null
          id: string
          is_dismissed: boolean | null
          is_read: boolean | null
          link: string | null
          message: string
          organization_id: string
          priority: number | null
          title: string
          type: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          business_id?: string | null
          category?: string
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          expires_at?: string | null
          id?: string
          is_dismissed?: boolean | null
          is_read?: boolean | null
          link?: string | null
          message: string
          organization_id: string
          priority?: number | null
          title: string
          type?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          business_id?: string | null
          category?: string
          created_at?: string | null
          entity_id?: string | null
          entity_type?: string | null
          expires_at?: string | null
          id?: string
          is_dismissed?: boolean | null
          is_read?: boolean | null
          link?: string | null
          message?: string
          organization_id?: string
          priority?: number | null
          title?: string
          type?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_attempts: {
        Row: {
          business_id: string | null
          company_name: string | null
          completed_at: string | null
          country: string | null
          currency: string | null
          diagnostics: Json
          error_message: string | null
          id: string
          idempotency_key: string | null
          organization_id: string | null
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id?: string | null
          company_name?: string | null
          completed_at?: string | null
          country?: string | null
          currency?: string | null
          diagnostics?: Json
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          organization_id?: string | null
          started_at?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string | null
          company_name?: string | null
          completed_at?: string | null
          country?: string | null
          currency?: string | null
          diagnostics?: Json
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          organization_id?: string | null
          started_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_attempts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "onboarding_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "onboarding_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_status: {
        Row: {
          attempt_count: number
          business_id: string | null
          completed_at: string | null
          error_message: string | null
          error_step: string | null
          id: string
          idempotency_key: string
          organization_id: string | null
          started_at: string
          status: string
          step: string
          steps_completed: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          business_id?: string | null
          completed_at?: string | null
          error_message?: string | null
          error_step?: string | null
          id?: string
          idempotency_key: string
          organization_id?: string | null
          started_at?: string
          status?: string
          step?: string
          steps_completed?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          attempt_count?: number
          business_id?: string | null
          completed_at?: string | null
          error_message?: string | null
          error_step?: string | null
          id?: string
          idempotency_key?: string
          organization_id?: string | null
          started_at?: string
          status?: string
          step?: string
          steps_completed?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_status_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "onboarding_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "onboarding_status_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_suggestions: {
        Row: {
          created_at: string
          id: string
          kind: string
          organization_id: string
          payload: Json
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          organization_id: string
          payload?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          payload?: Json
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_suggestions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "onboarding_suggestions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "onboarding_suggestions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_change_log: {
        Row: {
          actor_user_id: string | null
          business_id: string | null
          change_kind: Database["public"]["Enums"]["org_change_kind"]
          created_at: string
          entity_id: string
          entity_kind: Database["public"]["Enums"]["org_entity_kind"]
          id: string
          occurred_at: string
          organization_id: string
          payload: Json
          summary: string | null
        }
        Insert: {
          actor_user_id?: string | null
          business_id?: string | null
          change_kind: Database["public"]["Enums"]["org_change_kind"]
          created_at?: string
          entity_id: string
          entity_kind: Database["public"]["Enums"]["org_entity_kind"]
          id?: string
          occurred_at?: string
          organization_id: string
          payload?: Json
          summary?: string | null
        }
        Update: {
          actor_user_id?: string | null
          business_id?: string | null
          change_kind?: Database["public"]["Enums"]["org_change_kind"]
          created_at?: string
          entity_id?: string
          entity_kind?: Database["public"]["Enums"]["org_entity_kind"]
          id?: string
          occurred_at?: string
          organization_id?: string
          payload?: Json
          summary?: string | null
        }
        Relationships: []
      }
      org_usage_counters: {
        Row: {
          created_at: string
          current_value: number
          hard_limit: number | null
          id: string
          metric_key: string
          organization_id: string
          period_end: string
          period_start: string
          soft_limit: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          hard_limit?: number | null
          id?: string
          metric_key: string
          organization_id: string
          period_end?: string
          period_start?: string
          soft_limit?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_value?: number
          hard_limit?: number | null
          id?: string
          metric_key?: string
          organization_id?: string
          period_end?: string
          period_start?: string
          soft_limit?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_usage_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_usage_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "org_usage_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_api_integrations: {
        Row: {
          api_key_encrypted: string | null
          api_secret_encrypted: string | null
          business_id: string | null
          config: Json | null
          created_at: string | null
          display_name: string | null
          id: string
          integration_type: string
          is_active: boolean | null
          organization_id: string
          provider: string
          updated_at: string | null
        }
        Insert: {
          api_key_encrypted?: string | null
          api_secret_encrypted?: string | null
          business_id?: string | null
          config?: Json | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          integration_type: string
          is_active?: boolean | null
          organization_id: string
          provider: string
          updated_at?: string | null
        }
        Update: {
          api_key_encrypted?: string | null
          api_secret_encrypted?: string | null
          business_id?: string | null
          config?: Json | null
          created_at?: string | null
          display_name?: string | null
          id?: string
          integration_type?: string
          is_active?: boolean | null
          organization_id?: string
          provider?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organization_api_integrations_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_api_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_api_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_api_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_deletion_jobs: {
        Row: {
          attempts: number
          created_at: string
          error_text: string | null
          finished_at: string | null
          id: string
          kind: string
          organization_id: string
          organization_name: string | null
          requested_by: string | null
          result: Json | null
          scheduled_for: string | null
          started_at: string | null
          status: string
          storage_cleanup_pending: boolean
        }
        Insert: {
          attempts?: number
          created_at?: string
          error_text?: string | null
          finished_at?: string | null
          id?: string
          kind: string
          organization_id: string
          organization_name?: string | null
          requested_by?: string | null
          result?: Json | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          storage_cleanup_pending?: boolean
        }
        Update: {
          attempts?: number
          created_at?: string
          error_text?: string | null
          finished_at?: string | null
          id?: string
          kind?: string
          organization_id?: string
          organization_name?: string | null
          requested_by?: string | null
          result?: Json | null
          scheduled_for?: string | null
          started_at?: string | null
          status?: string
          storage_cleanup_pending?: boolean
        }
        Relationships: []
      }
      organization_installed_apps: {
        Row: {
          app_id: string
          created_at: string
          id: string
          installed_at: string
          installed_by: string | null
          is_active: boolean
          last_accessed_at: string | null
          lifecycle_state: Database["public"]["Enums"]["app_lifecycle_state"]
          onboarding_status: string
          organization_id: string
          settings: Json
          updated_at: string
        }
        Insert: {
          app_id: string
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          is_active?: boolean
          last_accessed_at?: string | null
          lifecycle_state?: Database["public"]["Enums"]["app_lifecycle_state"]
          onboarding_status?: string
          organization_id: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          app_id?: string
          created_at?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          is_active?: boolean
          last_accessed_at?: string | null
          lifecycle_state?: Database["public"]["Enums"]["app_lifecycle_state"]
          onboarding_status?: string
          organization_id?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_installed_apps_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_installed_apps_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_installed_apps_organization_id_fkey"
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
          branch_ids: string[]
          branch_scope: Database["public"]["Enums"]["branch_scope_mode"]
          created_at: string
          email: string
          employee_id: string | null
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string
          permission_group_ids: string[]
          primary_branch_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          token: string
          user_type: string
        }
        Insert: {
          accepted_at?: string | null
          branch_ids?: string[]
          branch_scope?: Database["public"]["Enums"]["branch_scope_mode"]
          created_at?: string
          email: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id: string
          permission_group_ids?: string[]
          primary_branch_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token?: string
          user_type?: string
        }
        Update: {
          accepted_at?: string | null
          branch_ids?: string[]
          branch_scope?: Database["public"]["Enums"]["branch_scope_mode"]
          created_at?: string
          email?: string
          employee_id?: string | null
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string
          permission_group_ids?: string[]
          primary_branch_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token?: string
          user_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_ownership_transfers: {
        Row: {
          created_at: string
          expires_at: string
          from_user_id: string
          id: string
          note: string | null
          organization_id: string
          responded_at: string | null
          status: string
          to_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          from_user_id: string
          id?: string
          note?: string | null
          organization_id: string
          responded_at?: string | null
          status?: string
          to_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          from_user_id?: string
          id?: string
          note?: string | null
          organization_id?: string
          responded_at?: string | null
          status?: string
          to_user_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_ownership_transfers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_ownership_transfers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_ownership_transfers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_payment_methods: {
        Row: {
          bank_account_id: string | null
          branch_id: string | null
          business_id: string
          created_at: string
          details: Json
          display_order: number | null
          id: string
          is_active: boolean | null
          is_default: boolean | null
          is_shared: boolean
          label: string
          organization_id: string
          qr_code_enabled: boolean | null
          type: Database["public"]["Enums"]["payment_method_type"]
          updated_at: string
        }
        Insert: {
          bank_account_id?: string | null
          branch_id?: string | null
          business_id: string
          created_at?: string
          details?: Json
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          is_shared?: boolean
          label: string
          organization_id: string
          qr_code_enabled?: boolean | null
          type: Database["public"]["Enums"]["payment_method_type"]
          updated_at?: string
        }
        Update: {
          bank_account_id?: string | null
          branch_id?: string | null
          business_id?: string
          created_at?: string
          details?: Json
          display_order?: number | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          is_shared?: boolean
          label?: string
          organization_id?: string
          qr_code_enabled?: boolean | null
          type?: Database["public"]["Enums"]["payment_method_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_payment_methods_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_payment_methods_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_payment_methods_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_payment_methods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_payment_methods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_payment_methods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_statutory_identifiers: {
        Row: {
          business_id: string | null
          country_code: string
          created_at: string
          effective_from: string | null
          effective_to: string | null
          id: string
          identifier_type: string
          identifier_value: string
          is_active: boolean
          organization_id: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          country_code: string
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          identifier_type: string
          identifier_value: string
          is_active?: boolean
          organization_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          country_code?: string
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          identifier_type?: string
          identifier_value?: string
          is_active?: boolean
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_statutory_identifiers_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_statutory_identifiers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_statutory_identifiers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "organization_statutory_identifiers_organization_id_fkey"
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
          date_format: string | null
          default_payment_terms: number | null
          default_tax_rate_id: string | null
          deletion_cancelled_at: string | null
          deletion_grace_days: number | null
          deletion_reason: string | null
          deletion_requested_by: string | null
          deletion_scheduled_at: string | null
          deletion_status: string
          edge_allowed_origins: string[]
          external_customer_id: string | null
          external_subscription_id: string | null
          fiscal_year_start: number | null
          fiscalyear_lock_date: string | null
          governance_mode: string
          id: string
          is_suspended: boolean | null
          logo_url: string | null
          name: string
          number_format: string | null
          onboarding_idempotency_key: string | null
          owner_user_id: string | null
          period_lock_date: string | null
          scheduled_deletion_at: string | null
          setup_wizard_completed: boolean | null
          setup_wizard_step: number | null
          slug: string
          subscription_ends_at: string | null
          subscription_started_at: string | null
          subscription_status: string | null
          suspended_at: string | null
          suspended_reason: string | null
          tax_lock_date: string | null
          timezone: string | null
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by_platform_admin?: boolean
          date_format?: string | null
          default_payment_terms?: number | null
          default_tax_rate_id?: string | null
          deletion_cancelled_at?: string | null
          deletion_grace_days?: number | null
          deletion_reason?: string | null
          deletion_requested_by?: string | null
          deletion_scheduled_at?: string | null
          deletion_status?: string
          edge_allowed_origins?: string[]
          external_customer_id?: string | null
          external_subscription_id?: string | null
          fiscal_year_start?: number | null
          fiscalyear_lock_date?: string | null
          governance_mode?: string
          id?: string
          is_suspended?: boolean | null
          logo_url?: string | null
          name: string
          number_format?: string | null
          onboarding_idempotency_key?: string | null
          owner_user_id?: string | null
          period_lock_date?: string | null
          scheduled_deletion_at?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          slug: string
          subscription_ends_at?: string | null
          subscription_started_at?: string | null
          subscription_status?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_lock_date?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by_platform_admin?: boolean
          date_format?: string | null
          default_payment_terms?: number | null
          default_tax_rate_id?: string | null
          deletion_cancelled_at?: string | null
          deletion_grace_days?: number | null
          deletion_reason?: string | null
          deletion_requested_by?: string | null
          deletion_scheduled_at?: string | null
          deletion_status?: string
          edge_allowed_origins?: string[]
          external_customer_id?: string | null
          external_subscription_id?: string | null
          fiscal_year_start?: number | null
          fiscalyear_lock_date?: string | null
          governance_mode?: string
          id?: string
          is_suspended?: boolean | null
          logo_url?: string | null
          name?: string
          number_format?: string | null
          onboarding_idempotency_key?: string | null
          owner_user_id?: string | null
          period_lock_date?: string | null
          scheduled_deletion_at?: string | null
          setup_wizard_completed?: boolean | null
          setup_wizard_step?: number | null
          slug?: string
          subscription_ends_at?: string | null
          subscription_started_at?: string | null
          subscription_status?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          tax_lock_date?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_default_tax_rate_id_fkey"
            columns: ["default_tax_rate_id"]
            isOneToOne: false
            referencedRelation: "tax_rates"
            referencedColumns: ["id"]
          },
        ]
      }
      output_dispatch_log: {
        Row: {
          artifact_id: string | null
          branch_id: string | null
          business_id: string | null
          correlation_id: string | null
          created_at: string
          created_by: string | null
          destination: string | null
          detail: Json
          disposition: string | null
          document_id: string | null
          document_kind: string | null
          document_record_id: string | null
          id: string
          intent: string | null
          intent_id: string | null
          medium: string | null
          organization_id: string | null
          resolved_targets: Json | null
          scenario: string | null
          status: string | null
          triggered_by: string | null
          triggered_source: string | null
        }
        Insert: {
          artifact_id?: string | null
          branch_id?: string | null
          business_id?: string | null
          correlation_id?: string | null
          created_at?: string
          created_by?: string | null
          destination?: string | null
          detail?: Json
          disposition?: string | null
          document_id?: string | null
          document_kind?: string | null
          document_record_id?: string | null
          id?: string
          intent?: string | null
          intent_id?: string | null
          medium?: string | null
          organization_id?: string | null
          resolved_targets?: Json | null
          scenario?: string | null
          status?: string | null
          triggered_by?: string | null
          triggered_source?: string | null
        }
        Update: {
          artifact_id?: string | null
          branch_id?: string | null
          business_id?: string | null
          correlation_id?: string | null
          created_at?: string
          created_by?: string | null
          destination?: string | null
          detail?: Json
          disposition?: string | null
          document_id?: string | null
          document_kind?: string | null
          document_record_id?: string | null
          id?: string
          intent?: string | null
          intent_id?: string | null
          medium?: string | null
          organization_id?: string | null
          resolved_targets?: Json | null
          scenario?: string | null
          status?: string | null
          triggered_by?: string | null
          triggered_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "output_dispatch_log_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "document_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_document_record_id_fkey"
            columns: ["document_record_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "output_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_dispatch_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "output_dispatch_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "output_dispatch_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      output_intent_targets: {
        Row: {
          copies: number
          created_at: string
          disposition: Database["public"]["Enums"]["output_disposition"]
          hardware_role: string | null
          id: string
          intent_id: string
          is_active: boolean
          medium: Database["public"]["Enums"]["output_medium"]
          params: Json
          priority: number
          template_code: string | null
          updated_at: string
        }
        Insert: {
          copies?: number
          created_at?: string
          disposition: Database["public"]["Enums"]["output_disposition"]
          hardware_role?: string | null
          id?: string
          intent_id: string
          is_active?: boolean
          medium: Database["public"]["Enums"]["output_medium"]
          params?: Json
          priority?: number
          template_code?: string | null
          updated_at?: string
        }
        Update: {
          copies?: number
          created_at?: string
          disposition?: Database["public"]["Enums"]["output_disposition"]
          hardware_role?: string | null
          id?: string
          intent_id?: string
          is_active?: boolean
          medium?: Database["public"]["Enums"]["output_medium"]
          params?: Json
          priority?: number
          template_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "output_intent_targets_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "output_intents"
            referencedColumns: ["id"]
          },
        ]
      }
      output_intents: {
        Row: {
          branch_id: string | null
          conditions: Json
          created_at: string
          created_by: string | null
          description: string | null
          document_kind: string
          id: string
          is_active: boolean
          name: string
          organization_id: string | null
          priority: number
          scenario: string
          scope: Database["public"]["Enums"]["output_scope"]
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          conditions?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          document_kind: string
          id?: string
          is_active?: boolean
          name: string
          organization_id?: string | null
          priority?: number
          scenario?: string
          scope: Database["public"]["Enums"]["output_scope"]
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          conditions?: Json
          created_at?: string
          created_by?: string | null
          description?: string | null
          document_kind?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string | null
          priority?: number
          scenario?: string
          scope?: Database["public"]["Enums"]["output_scope"]
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "output_intents_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "output_intents_document_kind_fkey"
            columns: ["document_kind"]
            isOneToOne: false
            referencedRelation: "document_kinds"
            referencedColumns: ["code"]
          },
        ]
      }
      payment_allocations: {
        Row: {
          amount: number
          branch_id: string | null
          created_at: string
          created_by: string | null
          id: string
          is_sample_data: boolean
          payment_id: string
          source: string
        }
        Insert: {
          amount: number
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_sample_data?: boolean
          payment_id: string
          source?: string
        }
        Update: {
          amount?: number
          branch_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_sample_data?: boolean
          payment_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_provider_configs: {
        Row: {
          business_id: string | null
          callback_url: string | null
          config: Json
          created_at: string | null
          display_name: string | null
          id: string
          is_active: boolean | null
          is_test_mode: boolean | null
          last_tested_at: string | null
          organization_id: string
          provider: string
          test_error: string | null
          test_result: string | null
          updated_at: string | null
        }
        Insert: {
          business_id?: string | null
          callback_url?: string | null
          config?: Json
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_active?: boolean | null
          is_test_mode?: boolean | null
          last_tested_at?: string | null
          organization_id: string
          provider: string
          test_error?: string | null
          test_result?: string | null
          updated_at?: string | null
        }
        Update: {
          business_id?: string | null
          callback_url?: string | null
          config?: Json
          created_at?: string | null
          display_name?: string | null
          id?: string
          is_active?: boolean | null
          is_test_mode?: boolean | null
          last_tested_at?: string | null
          organization_id?: string
          provider?: string
          test_error?: string | null
          test_result?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_provider_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payment_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "payment_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_requests: {
        Row: {
          amount: number
          business_id: string | null
          callback_payload: Json | null
          completed_at: string | null
          created_at: string | null
          currency: string | null
          expires_at: string | null
          id: string
          initiated_at: string | null
          merchant_request_id: string | null
          metadata: Json | null
          organization_id: string
          phone_number: string | null
          pos_transaction_id: string | null
          provider: string
          provider_reference: string | null
          receipt_number: string | null
          result_code: string | null
          result_description: string | null
          status: string | null
          updated_at: string | null
        }
        Insert: {
          amount: number
          business_id?: string | null
          callback_payload?: Json | null
          completed_at?: string | null
          created_at?: string | null
          currency?: string | null
          expires_at?: string | null
          id?: string
          initiated_at?: string | null
          merchant_request_id?: string | null
          metadata?: Json | null
          organization_id: string
          phone_number?: string | null
          pos_transaction_id?: string | null
          provider: string
          provider_reference?: string | null
          receipt_number?: string | null
          result_code?: string | null
          result_description?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Update: {
          amount?: number
          business_id?: string | null
          callback_payload?: Json | null
          completed_at?: string | null
          created_at?: string | null
          currency?: string | null
          expires_at?: string | null
          id?: string
          initiated_at?: string | null
          merchant_request_id?: string | null
          metadata?: Json | null
          organization_id?: string
          phone_number?: string | null
          pos_transaction_id?: string | null
          provider?: string
          provider_reference?: string | null
          receipt_number?: string | null
          result_code?: string | null
          result_description?: string | null
          status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_requests_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payment_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "payment_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_reversal_events: {
        Row: {
          amount_after_applied: number | null
          amount_after_outstanding: number | null
          amount_before_applied: number | null
          amount_before_outstanding: number | null
          business_id: string
          client_request_id: string | null
          credit_note_id: string | null
          customer_refund_id: string | null
          id: string
          notes: string | null
          op: string
          organization_id: string
          payment_id: string
          performed_at: string
          performed_by: string | null
          reason_code:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          reason_text: string | null
          reversal_journal_entry_id: string | null
        }
        Insert: {
          amount_after_applied?: number | null
          amount_after_outstanding?: number | null
          amount_before_applied?: number | null
          amount_before_outstanding?: number | null
          business_id: string
          client_request_id?: string | null
          credit_note_id?: string | null
          customer_refund_id?: string | null
          id?: string
          notes?: string | null
          op: string
          organization_id: string
          payment_id: string
          performed_at?: string
          performed_by?: string | null
          reason_code?:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          reason_text?: string | null
          reversal_journal_entry_id?: string | null
        }
        Update: {
          amount_after_applied?: number | null
          amount_after_outstanding?: number | null
          amount_before_applied?: number | null
          amount_before_outstanding?: number | null
          business_id?: string
          client_request_id?: string | null
          credit_note_id?: string | null
          customer_refund_id?: string | null
          id?: string
          notes?: string | null
          op?: string
          organization_id?: string
          payment_id?: string
          performed_at?: string
          performed_by?: string | null
          reason_code?:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          reason_text?: string | null
          reversal_journal_entry_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_reversal_events_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_terms: {
        Row: {
          business_id: string
          created_at: string
          days: number
          description: string | null
          id: string
          is_active: boolean | null
          is_default: boolean | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          days?: number
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          days?: number
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_terms_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_terms_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payment_terms_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "payment_terms_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          applied_amount: number
          approved_at: string | null
          approved_by: string | null
          bank_account_id: string | null
          branch_id: string | null
          business_id: string
          client_request_id: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          deposit_account_id: string | null
          direction: Database["public"]["Enums"]["payment_direction"]
          id: string
          is_sample_data: boolean
          journal_entry_id: string | null
          method: string | null
          migration_session_id: string | null
          notes: string | null
          organization_id: string
          outstanding_amount: number
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          reapplied_at: string | null
          reapplied_by: string | null
          reapply_reason: string | null
          receipt_number: string | null
          reference: string | null
          reversal_reason:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          status: string | null
          submitted_at: string | null
          submitted_by: string | null
          unreconcile_reason: string | null
          unreconciled_at: string | null
          unreconciled_by: string | null
          updated_at: string
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount?: number
          applied_amount?: number
          approved_at?: string | null
          approved_by?: string | null
          bank_account_id?: string | null
          branch_id?: string | null
          business_id: string
          client_request_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          deposit_account_id?: string | null
          direction?: Database["public"]["Enums"]["payment_direction"]
          id?: string
          is_sample_data?: boolean
          journal_entry_id?: string | null
          method?: string | null
          migration_session_id?: string | null
          notes?: string | null
          organization_id: string
          outstanding_amount?: number
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          reapplied_at?: string | null
          reapplied_by?: string | null
          reapply_reason?: string | null
          receipt_number?: string | null
          reference?: string | null
          reversal_reason?:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          unreconcile_reason?: string | null
          unreconciled_at?: string | null
          unreconciled_by?: string | null
          updated_at?: string
          void_reason?: string | null
          void_reason_code?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount?: number
          applied_amount?: number
          approved_at?: string | null
          approved_by?: string | null
          bank_account_id?: string | null
          branch_id?: string | null
          business_id?: string
          client_request_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          deposit_account_id?: string | null
          direction?: Database["public"]["Enums"]["payment_direction"]
          id?: string
          is_sample_data?: boolean
          journal_entry_id?: string | null
          method?: string | null
          migration_session_id?: string | null
          notes?: string | null
          organization_id?: string
          outstanding_amount?: number
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          reapplied_at?: string | null
          reapplied_by?: string | null
          reapply_reason?: string | null
          receipt_number?: string | null
          reference?: string | null
          reversal_reason?:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
          unreconcile_reason?: string | null
          unreconciled_at?: string | null
          unreconciled_by?: string | null
          updated_at?: string
          void_reason?: string | null
          void_reason_code?: string | null
          voided_at?: string | null
          voided_by?: string | null
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
            foreignKeyName: "payments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
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
            foreignKeyName: "payments_deposit_account_id_fkey"
            columns: ["deposit_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_deposit_account_id_fkey"
            columns: ["deposit_account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "payments_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_migration_session_id_fkey"
            columns: ["migration_session_id"]
            isOneToOne: false
            referencedRelation: "migration_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_void_reason_code_fkey"
            columns: ["void_reason_code"]
            isOneToOne: false
            referencedRelation: "reversal_reason_codes"
            referencedColumns: ["code"]
          },
        ]
      }
      permission_group_rules: {
        Row: {
          can_admin_override: boolean
          can_approve: boolean
          can_close: boolean
          can_create: boolean
          can_delete: boolean
          can_export: boolean
          can_pay: boolean
          can_post: boolean
          can_read: boolean
          can_reverse: boolean
          can_write: boolean
          id: string
          module: string
          permission_group_id: string
        }
        Insert: {
          can_admin_override?: boolean
          can_approve?: boolean
          can_close?: boolean
          can_create?: boolean
          can_delete?: boolean
          can_export?: boolean
          can_pay?: boolean
          can_post?: boolean
          can_read?: boolean
          can_reverse?: boolean
          can_write?: boolean
          id?: string
          module: string
          permission_group_id: string
        }
        Update: {
          can_admin_override?: boolean
          can_approve?: boolean
          can_close?: boolean
          can_create?: boolean
          can_delete?: boolean
          can_export?: boolean
          can_pay?: boolean
          can_post?: boolean
          can_read?: boolean
          can_reverse?: boolean
          can_write?: boolean
          id?: string
          module?: string
          permission_group_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "permission_group_rules_permission_group_id_fkey"
            columns: ["permission_group_id"]
            isOneToOne: false
            referencedRelation: "permission_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_groups: {
        Row: {
          created_at: string
          default_branch_scope:
            | Database["public"]["Enums"]["branch_scope_mode"]
            | null
          description: string | null
          id: string
          is_deprecated: boolean
          is_system: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_branch_scope?:
            | Database["public"]["Enums"]["branch_scope_mode"]
            | null
          description?: string | null
          id?: string
          is_deprecated?: boolean
          is_system?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_branch_scope?:
            | Database["public"]["Enums"]["branch_scope_mode"]
            | null
          description?: string | null
          id?: string
          is_deprecated?: boolean
          is_system?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "permission_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_apps: {
        Row: {
          category: string
          created_at: string
          description: string | null
          id: string
          is_available: boolean
          is_core: boolean
          is_free: boolean
          is_free_trial: boolean
          is_visible_in_signup: boolean
          name: string
          required_plan: string
          sort_order: number
          trial_days: number | null
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          description?: string | null
          id: string
          is_available?: boolean
          is_core?: boolean
          is_free?: boolean
          is_free_trial?: boolean
          is_visible_in_signup?: boolean
          name: string
          required_plan?: string
          sort_order?: number
          trial_days?: number | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          is_available?: boolean
          is_core?: boolean
          is_free?: boolean
          is_free_trial?: boolean
          is_visible_in_signup?: boolean
          name?: string
          required_plan?: string
          sort_order?: number
          trial_days?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      platform_exchange_rates: {
        Row: {
          created_at: string
          display_name: string | null
          from_currency: string
          id: string
          is_active: boolean | null
          rate: number
          symbol: string | null
          to_currency: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          from_currency?: string
          id?: string
          is_active?: boolean | null
          rate: number
          symbol?: string | null
          to_currency: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          from_currency?: string
          id?: string
          is_active?: boolean | null
          rate?: number
          symbol?: string | null
          to_currency?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_integration_capabilities: {
        Row: {
          created_at: string
          default_test_payload: Json | null
          description: string | null
          key: string
          name: string
        }
        Insert: {
          created_at?: string
          default_test_payload?: Json | null
          description?: string | null
          key: string
          name: string
        }
        Update: {
          created_at?: string
          default_test_payload?: Json | null
          description?: string | null
          key?: string
          name?: string
        }
        Relationships: []
      }
      platform_integration_connections: {
        Row: {
          auto_refresh_enabled: boolean
          auto_refresh_interval_hours: number
          capability_key: string
          config: Json
          created_at: string
          created_by: string | null
          credential_keys: string[]
          credentials: Json
          credentials_set_at: string | null
          display_label: string | null
          id: string
          is_active: boolean
          last_run_at: string | null
          last_run_message: string | null
          last_run_status: string | null
          last_test_at: string | null
          last_test_message: string | null
          last_test_ok: boolean | null
          next_run_at: string | null
          provider_id: string
          updated_at: string
        }
        Insert: {
          auto_refresh_enabled?: boolean
          auto_refresh_interval_hours?: number
          capability_key: string
          config?: Json
          created_at?: string
          created_by?: string | null
          credential_keys?: string[]
          credentials?: Json
          credentials_set_at?: string | null
          display_label?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          last_test_at?: string | null
          last_test_message?: string | null
          last_test_ok?: boolean | null
          next_run_at?: string | null
          provider_id: string
          updated_at?: string
        }
        Update: {
          auto_refresh_enabled?: boolean
          auto_refresh_interval_hours?: number
          capability_key?: string
          config?: Json
          created_at?: string
          created_by?: string | null
          credential_keys?: string[]
          credentials?: Json
          credentials_set_at?: string | null
          display_label?: string | null
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_message?: string | null
          last_run_status?: string | null
          last_test_at?: string | null
          last_test_message?: string | null
          last_test_ok?: boolean | null
          next_run_at?: string | null
          provider_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_integration_connections_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "platform_integration_capabilities"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "platform_integration_connections_provider_id_fkey"
            columns: ["provider_id"]
            isOneToOne: false
            referencedRelation: "platform_integration_providers"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_integration_providers: {
        Row: {
          capability_key: string
          config_schema: Json
          created_at: string
          credential_schema: Json
          description: string | null
          display_name: string
          docs_url: string | null
          id: string
          is_builtin: boolean
          is_enabled: boolean
          provider_key: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          capability_key: string
          config_schema?: Json
          created_at?: string
          credential_schema?: Json
          description?: string | null
          display_name: string
          docs_url?: string | null
          id?: string
          is_builtin?: boolean
          is_enabled?: boolean
          provider_key: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          capability_key?: string
          config_schema?: Json
          created_at?: string
          credential_schema?: Json
          description?: string | null
          display_name?: string
          docs_url?: string | null
          id?: string
          is_builtin?: boolean
          is_enabled?: boolean
          provider_key?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_integration_providers_capability_key_fkey"
            columns: ["capability_key"]
            isOneToOne: false
            referencedRelation: "platform_integration_capabilities"
            referencedColumns: ["key"]
          },
        ]
      }
      platform_integration_runs: {
        Row: {
          capability_key: string
          connection_id: string
          finished_at: string | null
          id: string
          message: string | null
          provider_id: string | null
          started_at: string
          stats: Json
          status: string
          trigger_kind: string
          triggered_by: string | null
        }
        Insert: {
          capability_key: string
          connection_id: string
          finished_at?: string | null
          id?: string
          message?: string | null
          provider_id?: string | null
          started_at?: string
          stats?: Json
          status?: string
          trigger_kind: string
          triggered_by?: string | null
        }
        Update: {
          capability_key?: string
          connection_id?: string
          finished_at?: string | null
          id?: string
          message?: string | null
          provider_id?: string | null
          started_at?: string
          stats?: Json
          status?: string
          trigger_kind?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_integration_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "platform_integration_connections"
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
      print_jobs: {
        Row: {
          acked_at: string | null
          artifact_id: string | null
          attempt_count: number
          branch_id: string | null
          business_id: string
          copies: number
          correlation_id: string
          created_at: string
          dedupe_key: string | null
          device_assignment_id: string | null
          disposition: Database["public"]["Enums"]["output_disposition"] | null
          doc_id: string | null
          doc_type: string
          document_record_id: string | null
          failed_at: string | null
          format: string
          hardware_role: string | null
          id: string
          intent: string
          last_error: string | null
          max_attempts: number
          media_profile_id: string | null
          medium: Database["public"]["Enums"]["output_medium"] | null
          next_attempt_at: string | null
          output_intent_id: string | null
          output_intent_target_id: string | null
          parent_job_id: string | null
          printer_profile_id: string | null
          processing_at: string | null
          render_params: Json
          requested_at: string
          requested_by: string | null
          requeued_count: number
          scenario: string
          sent_at: string | null
          status: Database["public"]["Enums"]["print_job_status"]
          transport: string
          triggered_source: string | null
          updated_at: string
        }
        Insert: {
          acked_at?: string | null
          artifact_id?: string | null
          attempt_count?: number
          branch_id?: string | null
          business_id: string
          copies?: number
          correlation_id: string
          created_at?: string
          dedupe_key?: string | null
          device_assignment_id?: string | null
          disposition?: Database["public"]["Enums"]["output_disposition"] | null
          doc_id?: string | null
          doc_type: string
          document_record_id?: string | null
          failed_at?: string | null
          format: string
          hardware_role?: string | null
          id?: string
          intent: string
          last_error?: string | null
          max_attempts?: number
          media_profile_id?: string | null
          medium?: Database["public"]["Enums"]["output_medium"] | null
          next_attempt_at?: string | null
          output_intent_id?: string | null
          output_intent_target_id?: string | null
          parent_job_id?: string | null
          printer_profile_id?: string | null
          processing_at?: string | null
          render_params?: Json
          requested_at?: string
          requested_by?: string | null
          requeued_count?: number
          scenario?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["print_job_status"]
          transport: string
          triggered_source?: string | null
          updated_at?: string
        }
        Update: {
          acked_at?: string | null
          artifact_id?: string | null
          attempt_count?: number
          branch_id?: string | null
          business_id?: string
          copies?: number
          correlation_id?: string
          created_at?: string
          dedupe_key?: string | null
          device_assignment_id?: string | null
          disposition?: Database["public"]["Enums"]["output_disposition"] | null
          doc_id?: string | null
          doc_type?: string
          document_record_id?: string | null
          failed_at?: string | null
          format?: string
          hardware_role?: string | null
          id?: string
          intent?: string
          last_error?: string | null
          max_attempts?: number
          media_profile_id?: string | null
          medium?: Database["public"]["Enums"]["output_medium"] | null
          next_attempt_at?: string | null
          output_intent_id?: string | null
          output_intent_target_id?: string | null
          parent_job_id?: string | null
          printer_profile_id?: string | null
          processing_at?: string | null
          render_params?: Json
          requested_at?: string
          requested_by?: string | null
          requeued_count?: number
          scenario?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["print_job_status"]
          transport?: string
          triggered_source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "print_jobs_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "document_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_document_record_id_fkey"
            columns: ["document_record_id"]
            isOneToOne: false
            referencedRelation: "document_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_output_intent_id_fkey"
            columns: ["output_intent_id"]
            isOneToOne: false
            referencedRelation: "output_intents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_output_intent_target_id_fkey"
            columns: ["output_intent_target_id"]
            isOneToOne: false
            referencedRelation: "output_intent_targets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_parent_job_id_fkey"
            columns: ["parent_job_id"]
            isOneToOne: false
            referencedRelation: "print_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      print_traces: {
        Row: {
          attributes: Json
          business_id: string | null
          correlation_id: string
          created_at: string
          created_by: string
          id: string
          label: string
          organization_id: string | null
          spans: Json
          total_ms: number
        }
        Insert: {
          attributes?: Json
          business_id?: string | null
          correlation_id: string
          created_at?: string
          created_by?: string
          id?: string
          label: string
          organization_id?: string | null
          spans?: Json
          total_ms?: number
        }
        Update: {
          attributes?: Json
          business_id?: string | null
          correlation_id?: string
          created_at?: string
          created_by?: string
          id?: string
          label?: string
          organization_id?: string | null
          spans?: Json
          total_ms?: number
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "profiles_last_org_id_fkey"
            columns: ["last_org_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "profiles_last_org_id_fkey"
            columns: ["last_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_journal_templates: {
        Row: {
          business_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          end_date: string | null
          frequency: string
          id: string
          is_active: boolean | null
          is_auto_post: boolean | null
          lines: Json
          next_run_date: string
          organization_id: string
          reference_prefix: string | null
          source_type: string | null
          template_name: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          end_date?: string | null
          frequency?: string
          id?: string
          is_active?: boolean | null
          is_auto_post?: boolean | null
          lines?: Json
          next_run_date: string
          organization_id: string
          reference_prefix?: string | null
          source_type?: string | null
          template_name: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          end_date?: string | null
          frequency?: string
          id?: string
          is_active?: boolean | null
          is_auto_post?: boolean | null
          lines?: Json
          next_run_date?: string
          organization_id?: string
          reference_prefix?: string | null
          source_type?: string | null
          template_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_journal_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_journal_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "recurring_journal_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "recurring_journal_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      report_access_log: {
        Row: {
          accessed_at: string
          id: string
          organization_id: string
          report_path: string
          report_type: string
          user_id: string
        }
        Insert: {
          accessed_at?: string
          id?: string
          organization_id: string
          report_path: string
          report_type: string
          user_id: string
        }
        Update: {
          accessed_at?: string
          id?: string
          organization_id?: string
          report_path?: string
          report_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_access_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "report_access_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "report_access_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      report_field_configs: {
        Row: {
          config_name: string
          created_at: string
          created_by: string | null
          entity_type: string
          field_order: string[] | null
          footer_fields: string[] | null
          header_fields: string[] | null
          id: string
          included_core_fields: string[] | null
          included_custom_fields: string[] | null
          is_default: boolean
          organization_id: string
          report_type: string
          updated_at: string
        }
        Insert: {
          config_name?: string
          created_at?: string
          created_by?: string | null
          entity_type: string
          field_order?: string[] | null
          footer_fields?: string[] | null
          header_fields?: string[] | null
          id?: string
          included_core_fields?: string[] | null
          included_custom_fields?: string[] | null
          is_default?: boolean
          organization_id: string
          report_type?: string
          updated_at?: string
        }
        Update: {
          config_name?: string
          created_at?: string
          created_by?: string | null
          entity_type?: string
          field_order?: string[] | null
          footer_fields?: string[] | null
          header_fields?: string[] | null
          id?: string
          included_core_fields?: string[] | null
          included_custom_fields?: string[] | null
          is_default?: boolean
          organization_id?: string
          report_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "report_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "report_field_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      report_generation_logs: {
        Row: {
          branch_id: string | null
          business_id: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          file_size_bytes: number | null
          file_url: string | null
          generated_by: string | null
          id: string
          organization_id: string
          parameters: Json | null
          recipients_sent: Json | null
          report_type: string
          scheduled_report_id: string | null
          started_at: string | null
          status: string
          template_id: string | null
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_size_bytes?: number | null
          file_url?: string | null
          generated_by?: string | null
          id?: string
          organization_id: string
          parameters?: Json | null
          recipients_sent?: Json | null
          report_type: string
          scheduled_report_id?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          file_size_bytes?: number | null
          file_url?: string | null
          generated_by?: string | null
          id?: string
          organization_id?: string
          parameters?: Json | null
          recipients_sent?: Json | null
          report_type?: string
          scheduled_report_id?: string | null
          started_at?: string | null
          status?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "report_generation_logs_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_generation_logs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_generation_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "report_generation_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "report_generation_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_generation_logs_scheduled_report_id_fkey"
            columns: ["scheduled_report_id"]
            isOneToOne: false
            referencedRelation: "scheduled_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      report_saved_views: {
        Row: {
          business_id: string | null
          created_at: string
          filters_json: Json
          id: string
          is_default: boolean
          is_favorite: boolean
          last_accessed_at: string | null
          organization_id: string
          report_type: string
          updated_at: string
          user_id: string
          view_name: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          filters_json?: Json
          id?: string
          is_default?: boolean
          is_favorite?: boolean
          last_accessed_at?: string | null
          organization_id: string
          report_type: string
          updated_at?: string
          user_id: string
          view_name: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          filters_json?: Json
          id?: string
          is_default?: boolean
          is_favorite?: boolean
          last_accessed_at?: string | null
          organization_id?: string
          report_type?: string
          updated_at?: string
          user_id?: string
          view_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_saved_views_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "report_saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "report_saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      report_views: {
        Row: {
          branch_id: string | null
          business_id: string | null
          id: string
          opened_at: string
          organization_id: string
          params: Json
          path: string | null
          report_id: string
          report_type: string | null
          user_id: string
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          id?: string
          opened_at?: string
          organization_id: string
          params?: Json
          path?: string | null
          report_id: string
          report_type?: string | null
          user_id: string
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          id?: string
          opened_at?: string
          organization_id?: string
          params?: Json
          path?: string | null
          report_id?: string
          report_type?: string | null
          user_id?: string
        }
        Relationships: []
      }
      reset_runs: {
        Row: {
          categories: string[] | null
          counts: Json | null
          created_at: string
          duration_ms: number | null
          error: string | null
          error_code: string | null
          error_hint: string | null
          finished_at: string | null
          id: string
          initiated_by: string | null
          mode: string
          ok: boolean | null
          organization_id: string | null
          stage: string
          started_at: string
          storage_result: Json | null
          trigger_source: string | null
        }
        Insert: {
          categories?: string[] | null
          counts?: Json | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          error_code?: string | null
          error_hint?: string | null
          finished_at?: string | null
          id?: string
          initiated_by?: string | null
          mode: string
          ok?: boolean | null
          organization_id?: string | null
          stage?: string
          started_at?: string
          storage_result?: Json | null
          trigger_source?: string | null
        }
        Update: {
          categories?: string[] | null
          counts?: Json | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          error_code?: string | null
          error_hint?: string | null
          finished_at?: string | null
          id?: string
          initiated_by?: string | null
          mode?: string
          ok?: boolean | null
          organization_id?: string | null
          stage?: string
          started_at?: string
          storage_result?: Json | null
          trigger_source?: string | null
        }
        Relationships: []
      }
      reversal_approval_policies: {
        Row: {
          amount_threshold: number | null
          business_id: string | null
          created_at: string
          created_by: string | null
          document_type: string
          id: string
          is_active: boolean
          organization_id: string
          require_for_prior_period: boolean
          updated_at: string
        }
        Insert: {
          amount_threshold?: number | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          document_type: string
          id?: string
          is_active?: boolean
          organization_id: string
          require_for_prior_period?: boolean
          updated_at?: string
        }
        Update: {
          amount_threshold?: number | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          document_type?: string
          id?: string
          is_active?: boolean
          organization_id?: string
          require_for_prior_period?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      reversal_reason_codes: {
        Row: {
          active: boolean
          applies_to: string[]
          code: string
          created_at: string
          description: string | null
          label: string
          requires_comment: boolean
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          applies_to: string[]
          code: string
          created_at?: string
          description?: string | null
          label: string
          requires_comment?: boolean
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          applies_to?: string[]
          code?: string
          created_at?: string
          description?: string | null
          label?: string
          requires_comment?: boolean
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      saved_views: {
        Row: {
          business_id: string | null
          created_at: string
          entity_type: string
          id: string
          is_default: boolean | null
          is_shared: boolean | null
          organization_id: string
          quick_filters: Json | null
          updated_at: string
          user_id: string | null
          view_config: Json
          view_name: string
          view_type: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          entity_type: string
          id?: string
          is_default?: boolean | null
          is_shared?: boolean | null
          organization_id: string
          quick_filters?: Json | null
          updated_at?: string
          user_id?: string | null
          view_config?: Json
          view_name: string
          view_type?: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          entity_type?: string
          id?: string
          is_default?: boolean | null
          is_shared?: boolean | null
          organization_id?: string
          quick_filters?: Json | null
          updated_at?: string
          user_id?: string | null
          view_config?: Json
          view_name?: string
          view_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_views_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_reports: {
        Row: {
          branch_id: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          date_range_type: string | null
          filters: Json | null
          format: string | null
          id: string
          include_charts: boolean | null
          is_active: boolean | null
          last_sent_at: string | null
          name: string
          next_send_at: string | null
          organization_id: string
          recipients: Json
          report_type: string
          schedule_config: Json | null
          schedule_type: string
          template_id: string | null
          updated_at: string
        }
        Insert: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          date_range_type?: string | null
          filters?: Json | null
          format?: string | null
          id?: string
          include_charts?: boolean | null
          is_active?: boolean | null
          last_sent_at?: string | null
          name: string
          next_send_at?: string | null
          organization_id: string
          recipients?: Json
          report_type: string
          schedule_config?: Json | null
          schedule_type: string
          template_id?: string | null
          updated_at?: string
        }
        Update: {
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          date_range_type?: string | null
          filters?: Json | null
          format?: string | null
          id?: string
          include_charts?: boolean | null
          is_active?: boolean | null
          last_sent_at?: string | null
          name?: string
          next_send_at?: string | null
          organization_id?: string
          recipients?: Json
          report_type?: string
          schedule_config?: Json | null
          schedule_type?: string
          template_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_reports_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_reports_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "scheduled_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "scheduled_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      security_alerts: {
        Row: {
          action_expires_at: string | null
          action_token: string | null
          action_url: string | null
          alert_type: string
          created_at: string
          device_id: string | null
          email_sent: boolean
          email_sent_at: string | null
          id: string
          is_read: boolean
          is_resolved: boolean
          login_history_id: string | null
          message: string
          read_at: string | null
          resolved_action: string | null
          resolved_at: string | null
          severity: string
          title: string
          user_id: string
        }
        Insert: {
          action_expires_at?: string | null
          action_token?: string | null
          action_url?: string | null
          alert_type: string
          created_at?: string
          device_id?: string | null
          email_sent?: boolean
          email_sent_at?: string | null
          id?: string
          is_read?: boolean
          is_resolved?: boolean
          login_history_id?: string | null
          message: string
          read_at?: string | null
          resolved_action?: string | null
          resolved_at?: string | null
          severity: string
          title: string
          user_id: string
        }
        Update: {
          action_expires_at?: string | null
          action_token?: string | null
          action_url?: string | null
          alert_type?: string
          created_at?: string
          device_id?: string | null
          email_sent?: boolean
          email_sent_at?: string | null
          id?: string
          is_read?: boolean
          is_resolved?: boolean
          login_history_id?: string | null
          message?: string
          read_at?: string | null
          resolved_action?: string | null
          resolved_at?: string | null
          severity?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_alerts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "user_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_alerts_login_history_id_fkey"
            columns: ["login_history_id"]
            isOneToOne: false
            referencedRelation: "login_history"
            referencedColumns: ["id"]
          },
        ]
      }
      self_action_overrides: {
        Row: {
          action_key: string
          actor_user_id: string
          co_signed_by: string
          consumed_at: string | null
          consumed_entity_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          expires_at: string
          id: string
          organization_id: string
          reason: string
          subject_user_id: string
        }
        Insert: {
          action_key: string
          actor_user_id: string
          co_signed_by: string
          consumed_at?: string | null
          consumed_entity_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          expires_at?: string
          id?: string
          organization_id: string
          reason: string
          subject_user_id: string
        }
        Update: {
          action_key?: string
          actor_user_id?: string
          co_signed_by?: string
          consumed_at?: string | null
          consumed_entity_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          reason?: string
          subject_user_id?: string
        }
        Relationships: []
      }
      self_action_policy: {
        Row: {
          action_key: string
          applies_to_role: Database["public"]["Enums"]["app_role"] | null
          created_at: string
          created_by: string | null
          id: string
          mode: string
          notes: string | null
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          action_key: string
          applies_to_role?: Database["public"]["Enums"]["app_role"] | null
          created_at?: string
          created_by?: string | null
          id?: string
          mode?: string
          notes?: string | null
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          action_key?: string
          applies_to_role?: Database["public"]["Enums"]["app_role"] | null
          created_at?: string
          created_by?: string | null
          id?: string
          mode?: string
          notes?: string | null
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      sensitive_field_audit: {
        Row: {
          action_key: string | null
          changed_at: string
          changed_by: string | null
          column_name: string
          id: string
          new_value_masked: string | null
          old_value_masked: string | null
          organization_id: string
          override_id: string | null
          record_id: string
          table_name: string
        }
        Insert: {
          action_key?: string | null
          changed_at?: string
          changed_by?: string | null
          column_name: string
          id?: string
          new_value_masked?: string | null
          old_value_masked?: string | null
          organization_id: string
          override_id?: string | null
          record_id: string
          table_name: string
        }
        Update: {
          action_key?: string | null
          changed_at?: string
          changed_by?: string | null
          column_name?: string
          id?: string
          new_value_masked?: string | null
          old_value_masked?: string | null
          organization_id?: string
          override_id?: string | null
          record_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "sensitive_field_audit_override_id_fkey"
            columns: ["override_id"]
            isOneToOne: false
            referencedRelation: "self_action_overrides"
            referencedColumns: ["id"]
          },
        ]
      }
      settings_audit_log: {
        Row: {
          actor_id: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string
          id: string
          new_value: Json | null
          old_value: Json | null
          organization_id: string
          reason: string | null
          record_id: string | null
          setting_key: string
          setting_scope: string
          table_name: string
        }
        Insert: {
          actor_id?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          organization_id: string
          reason?: string | null
          record_id?: string | null
          setting_key: string
          setting_scope: string
          table_name: string
        }
        Update: {
          actor_id?: string | null
          branch_id?: string | null
          business_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          organization_id?: string
          reason?: string | null
          record_id?: string | null
          setting_key?: string
          setting_scope?: string
          table_name?: string
        }
        Relationships: []
      }
      signup_cleanup_log: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          reaped_email: string | null
          reaped_user_id: string
          reason: string
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          reaped_email?: string | null
          reaped_user_id: string
          reason: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          reaped_email?: string | null
          reaped_user_id?: string
          reason?: string
        }
        Relationships: []
      }
      sms_event_outbox: {
        Row: {
          attempts: number
          business_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id: string
          last_error: string | null
          next_attempt_at: string
          organization_id: string
          processed_at: string | null
          recipient_contact_id: string | null
          recipient_employee_id: string | null
          recipient_phone: string | null
          recipient_type: string | null
          recipient_vendor_id: string | null
          status: string
          template_variables: Json
        }
        Insert: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          organization_id: string
          processed_at?: string | null
          recipient_contact_id?: string | null
          recipient_employee_id?: string | null
          recipient_phone?: string | null
          recipient_type?: string | null
          recipient_vendor_id?: string | null
          status?: string
          template_variables?: Json
        }
        Update: {
          attempts?: number
          business_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          event_type?: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          organization_id?: string
          processed_at?: string | null
          recipient_contact_id?: string | null
          recipient_employee_id?: string | null
          recipient_phone?: string | null
          recipient_type?: string | null
          recipient_vendor_id?: string | null
          status?: string
          template_variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "sms_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_event_outbox_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_event_rule_recipients: {
        Row: {
          created_at: string
          group_id: string | null
          id: string
          is_fallback: boolean
          phone: string | null
          recipient_kind: string
          role: Database["public"]["Enums"]["app_role"] | null
          rule_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          group_id?: string | null
          id?: string
          is_fallback?: boolean
          phone?: string | null
          recipient_kind: string
          role?: Database["public"]["Enums"]["app_role"] | null
          rule_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          group_id?: string | null
          id?: string
          is_fallback?: boolean
          phone?: string | null
          recipient_kind?: string
          role?: Database["public"]["Enums"]["app_role"] | null
          rule_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_event_rule_recipients_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "sms_recipient_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_event_rule_recipients_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "sms_event_rules"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_event_rules: {
        Row: {
          business_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id: string
          is_enabled: boolean
          organization_id: string
          recipient_type: Database["public"]["Enums"]["sms_recipient_type"]
          template_id: string | null
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          is_enabled?: boolean
          organization_id: string
          recipient_type?: Database["public"]["Enums"]["sms_recipient_type"]
          template_id?: string | null
        }
        Update: {
          business_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          is_enabled?: boolean
          organization_id?: string
          recipient_type?: Database["public"]["Enums"]["sms_recipient_type"]
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_event_rules_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_event_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_event_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_event_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_event_rules_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_log: {
        Row: {
          business_id: string | null
          cost: number | null
          cost_unit: string | null
          created_at: string
          delivered_at: string | null
          direction: string
          entity_id: string | null
          entity_type: string | null
          error_code: string | null
          error_message: string | null
          event_type: Database["public"]["Enums"]["sms_event_type"] | null
          from_phone: string | null
          id: string
          is_test: boolean
          message_body: string
          next_retry_at: string | null
          organization_id: string
          provider_message_id: string | null
          provider_mode: string
          recipient_phone: string
          retry_count: number
          sent_at: string | null
          sent_by: string | null
          status: Database["public"]["Enums"]["sms_status"]
          template_id: string | null
          triggered_by: string
        }
        Insert: {
          business_id?: string | null
          cost?: number | null
          cost_unit?: string | null
          created_at?: string
          delivered_at?: string | null
          direction?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          error_message?: string | null
          event_type?: Database["public"]["Enums"]["sms_event_type"] | null
          from_phone?: string | null
          id?: string
          is_test?: boolean
          message_body: string
          next_retry_at?: string | null
          organization_id: string
          provider_message_id?: string | null
          provider_mode?: string
          recipient_phone: string
          retry_count?: number
          sent_at?: string | null
          sent_by?: string | null
          status?: Database["public"]["Enums"]["sms_status"]
          template_id?: string | null
          triggered_by?: string
        }
        Update: {
          business_id?: string | null
          cost?: number | null
          cost_unit?: string | null
          created_at?: string
          delivered_at?: string | null
          direction?: string
          entity_id?: string | null
          entity_type?: string | null
          error_code?: string | null
          error_message?: string | null
          event_type?: Database["public"]["Enums"]["sms_event_type"] | null
          from_phone?: string | null
          id?: string
          is_test?: boolean
          message_body?: string
          next_retry_at?: string | null
          organization_id?: string
          provider_message_id?: string | null
          provider_mode?: string
          recipient_phone?: string
          retry_count?: number
          sent_at?: string | null
          sent_by?: string | null
          status?: Database["public"]["Enums"]["sms_status"]
          template_id?: string | null
          triggered_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_log_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_log_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "sms_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_opt_outs: {
        Row: {
          business_id: string | null
          created_at: string
          id: string
          opted_out_at: string
          organization_id: string
          phone_number: string
          reason: string | null
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          id?: string
          opted_out_at?: string
          organization_id: string
          phone_number: string
          reason?: string | null
        }
        Update: {
          business_id?: string | null
          created_at?: string
          id?: string
          opted_out_at?: string
          organization_id?: string
          phone_number?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_opt_outs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_opt_outs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_opt_outs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_opt_outs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_provider_configs: {
        Row: {
          account_sid: string
          auth_token: string
          business_id: string | null
          created_at: string
          created_by: string | null
          daily_limit: number | null
          help_message: string
          id: string
          inbound_enabled: boolean
          is_enabled: boolean
          last_reset_date: string | null
          last_test_at: string | null
          last_test_error: string | null
          last_test_status: string | null
          messages_sent_today: number | null
          messaging_service_sid: string | null
          organization_id: string
          provider: Database["public"]["Enums"]["sms_provider"]
          provider_mode: string
          sender_phone: string | null
          sms_compliance_acknowledged_at: string | null
          sms_compliance_acknowledged_by: string | null
          updated_at: string
          webhook_url: string | null
        }
        Insert: {
          account_sid?: string
          auth_token?: string
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_limit?: number | null
          help_message?: string
          id?: string
          inbound_enabled?: boolean
          is_enabled?: boolean
          last_reset_date?: string | null
          last_test_at?: string | null
          last_test_error?: string | null
          last_test_status?: string | null
          messages_sent_today?: number | null
          messaging_service_sid?: string | null
          organization_id: string
          provider?: Database["public"]["Enums"]["sms_provider"]
          provider_mode?: string
          sender_phone?: string | null
          sms_compliance_acknowledged_at?: string | null
          sms_compliance_acknowledged_by?: string | null
          updated_at?: string
          webhook_url?: string | null
        }
        Update: {
          account_sid?: string
          auth_token?: string
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          daily_limit?: number | null
          help_message?: string
          id?: string
          inbound_enabled?: boolean
          is_enabled?: boolean
          last_reset_date?: string | null
          last_test_at?: string | null
          last_test_error?: string | null
          last_test_status?: string | null
          messages_sent_today?: number | null
          messaging_service_sid?: string | null
          organization_id?: string
          provider?: Database["public"]["Enums"]["sms_provider"]
          provider_mode?: string
          sender_phone?: string | null
          sms_compliance_acknowledged_at?: string | null
          sms_compliance_acknowledged_by?: string | null
          updated_at?: string
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_provider_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_recipient_group_members: {
        Row: {
          created_at: string
          group_id: string
          id: string
          label: string | null
          member_kind: string
          phone: string | null
          role: Database["public"]["Enums"]["app_role"] | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          label?: string | null
          member_kind: string
          phone?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          label?: string | null
          member_kind?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_recipient_group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "sms_recipient_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_recipient_groups: {
        Row: {
          business_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_recipient_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_recipient_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_recipient_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_templates: {
        Row: {
          body_template: string
          business_id: string | null
          created_at: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id: string
          is_active: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          body_template: string
          business_id?: string | null
          created_at?: string
          event_type: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          body_template?: string
          business_id?: string | null
          created_at?: string
          event_type?: Database["public"]["Enums"]["sms_event_type"]
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sms_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_bucket_conventions: {
        Row: {
          bucket_id: string
          created_at: string
          entity_table: string | null
          id: string
          is_legacy: boolean
          module: string
          owner_kind: string
          path_regex: string
          path_template: string
          priority: number
          updated_at: string
        }
        Insert: {
          bucket_id: string
          created_at?: string
          entity_table?: string | null
          id?: string
          is_legacy?: boolean
          module?: string
          owner_kind: string
          path_regex: string
          path_template: string
          priority?: number
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          created_at?: string
          entity_table?: string | null
          id?: string
          is_legacy?: boolean
          module?: string
          owner_kind?: string
          path_regex?: string
          path_template?: string
          priority?: number
          updated_at?: string
        }
        Relationships: []
      }
      storage_gc_runs: {
        Row: {
          bytes_freed: number
          dry_run: boolean
          errors: Json
          finished_at: string | null
          id: string
          objects_removed: number
          objects_resolved: number
          per_bucket: Json
          scope: string
          started_at: string
          target_id: string | null
          trigger_source: string
          triggered_by: string | null
        }
        Insert: {
          bytes_freed?: number
          dry_run?: boolean
          errors?: Json
          finished_at?: string | null
          id?: string
          objects_removed?: number
          objects_resolved?: number
          per_bucket?: Json
          scope: string
          started_at?: string
          target_id?: string | null
          trigger_source?: string
          triggered_by?: string | null
        }
        Update: {
          bytes_freed?: number
          dry_run?: boolean
          errors?: Json
          finished_at?: string | null
          id?: string
          objects_removed?: number
          objects_resolved?: number
          per_bucket?: Json
          scope?: string
          started_at?: string
          target_id?: string | null
          trigger_source?: string
          triggered_by?: string | null
        }
        Relationships: []
      }
      storage_object_ownership: {
        Row: {
          bucket_id: string
          convention_id: string | null
          entity_id: string | null
          entity_type: string | null
          inferred_at: string
          is_legacy_path: boolean
          module: string
          needs_review: boolean
          object_name: string
          organization_id: string | null
          owner_kind: string
          owner_user_id: string | null
        }
        Insert: {
          bucket_id: string
          convention_id?: string | null
          entity_id?: string | null
          entity_type?: string | null
          inferred_at?: string
          is_legacy_path?: boolean
          module?: string
          needs_review?: boolean
          object_name: string
          organization_id?: string | null
          owner_kind: string
          owner_user_id?: string | null
        }
        Update: {
          bucket_id?: string
          convention_id?: string | null
          entity_id?: string | null
          entity_type?: string | null
          inferred_at?: string
          is_legacy_path?: boolean
          module?: string
          needs_review?: boolean
          object_name?: string
          organization_id?: string | null
          owner_kind?: string
          owner_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "storage_object_ownership_convention_id_fkey"
            columns: ["convention_id"]
            isOneToOne: false
            referencedRelation: "storage_bucket_conventions"
            referencedColumns: ["id"]
          },
        ]
      }
      system_account_roles: {
        Row: {
          category: string
          created_at: string
          description: string
          is_mandatory: boolean
          label: string
          required_account_type: Database["public"]["Enums"]["account_type"]
          role_key: string
          sort_order: number
        }
        Insert: {
          category: string
          created_at?: string
          description: string
          is_mandatory?: boolean
          label: string
          required_account_type: Database["public"]["Enums"]["account_type"]
          role_key: string
          sort_order?: number
        }
        Update: {
          category?: string
          created_at?: string
          description?: string
          is_mandatory?: boolean
          label?: string
          required_account_type?: Database["public"]["Enums"]["account_type"]
          role_key?: string
          sort_order?: number
        }
        Relationships: []
      }
      system_account_template: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at: string
          description: string | null
          detail_type: string
          parent_code_hint: string | null
          role_key: string
          suggested_code: string
          suggested_name: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          created_at?: string
          description?: string | null
          detail_type: string
          parent_code_hint?: string | null
          role_key: string
          suggested_code: string
          suggested_name: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          created_at?: string
          description?: string | null
          detail_type?: string
          parent_code_hint?: string | null
          role_key?: string
          suggested_code?: string
          suggested_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "system_account_template_detail_fk"
            columns: ["account_type", "detail_type"]
            isOneToOne: false
            referencedRelation: "account_detail_type_catalog"
            referencedColumns: ["account_type", "detail_type"]
          },
          {
            foreignKeyName: "system_account_template_role_key_fkey"
            columns: ["role_key"]
            isOneToOne: true
            referencedRelation: "system_account_roles"
            referencedColumns: ["role_key"]
          },
        ]
      }
      tax_compliance_configs: {
        Row: {
          business_id: string | null
          config: Json | null
          country_code: string
          created_at: string | null
          device_serial: string | null
          id: string
          is_active: boolean | null
          is_test_mode: boolean | null
          last_sync_at: string | null
          organization_id: string
          provider: string
          sync_status: string | null
          updated_at: string | null
        }
        Insert: {
          business_id?: string | null
          config?: Json | null
          country_code: string
          created_at?: string | null
          device_serial?: string | null
          id?: string
          is_active?: boolean | null
          is_test_mode?: boolean | null
          last_sync_at?: string | null
          organization_id: string
          provider: string
          sync_status?: string | null
          updated_at?: string | null
        }
        Update: {
          business_id?: string | null
          config?: Json | null
          country_code?: string
          created_at?: string | null
          device_serial?: string | null
          id?: string
          is_active?: boolean | null
          is_test_mode?: boolean | null
          last_sync_at?: string | null
          organization_id?: string
          provider?: string
          sync_status?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tax_compliance_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_compliance_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tax_compliance_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "tax_compliance_configs_organization_id_fkey"
            columns: ["organization_id"]
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
          business_id: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_groups_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tax_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
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
          business_id: string
          created_at: string
          effective_from: string
          effective_to: string | null
          etims_tax_code: string | null
          fixed_amount: number
          id: string
          is_active: boolean
          is_compound: boolean
          name: string
          organization_id: string
          rate: number
          tax_type: string
          updated_at: string
        }
        Insert: {
          business_id: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          etims_tax_code?: string | null
          fixed_amount?: number
          id?: string
          is_active?: boolean
          is_compound?: boolean
          name: string
          organization_id: string
          rate?: number
          tax_type?: string
          updated_at?: string
        }
        Update: {
          business_id?: string
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          etims_tax_code?: string | null
          fixed_amount?: number
          id?: string
          is_active?: boolean
          is_compound?: boolean
          name?: string
          organization_id?: string
          rate?: number
          tax_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_rates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tax_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "tax_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_report_template_lines: {
        Row: {
          account_ids: string[] | null
          created_at: string
          description: string | null
          formula: string | null
          id: string
          is_bold: boolean | null
          label: string
          line_number: string
          line_type: string
          sort_order: number
          tax_rate_ids: string[] | null
          template_id: string
        }
        Insert: {
          account_ids?: string[] | null
          created_at?: string
          description?: string | null
          formula?: string | null
          id?: string
          is_bold?: boolean | null
          label: string
          line_number: string
          line_type?: string
          sort_order?: number
          tax_rate_ids?: string[] | null
          template_id: string
        }
        Update: {
          account_ids?: string[] | null
          created_at?: string
          description?: string | null
          formula?: string | null
          id?: string
          is_bold?: boolean | null
          label?: string
          line_number?: string
          line_type?: string
          sort_order?: number
          tax_rate_ids?: string[] | null
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_report_template_lines_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "tax_report_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_report_templates: {
        Row: {
          business_id: string | null
          country_code: string | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          report_type: string
          updated_at: string
        }
        Insert: {
          business_id?: string | null
          country_code?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          report_type?: string
          updated_at?: string
        }
        Update: {
          business_id?: string | null
          country_code?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          report_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_report_templates_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tax_report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "tax_report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_active_business: {
        Row: {
          business_id: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_active_business_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_active_business_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_active_business_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_active_business_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_activity_logs: {
        Row: {
          activity_details: Json | null
          activity_type: string
          created_at: string | null
          id: string
          ip_address: string | null
          organization_id: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          activity_details?: Json | null
          activity_type: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          organization_id?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          activity_details?: Json | null
          activity_type?: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          organization_id?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_activity_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_activity_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_activity_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_branch_assignments: {
        Row: {
          assigned_by: string | null
          branch_id: string
          business_id: string
          can_manage: boolean | null
          can_view: boolean | null
          created_at: string | null
          id: string
          is_primary: boolean | null
          organization_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          branch_id: string
          business_id: string
          can_manage?: boolean | null
          can_view?: boolean | null
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          organization_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          branch_id?: string
          business_id?: string
          can_manage?: boolean | null
          can_view?: boolean | null
          created_at?: string | null
          id?: string
          is_primary?: boolean | null
          organization_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_branch_assignments_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_branch_assignments_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_branch_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_branch_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_branch_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_business_access: {
        Row: {
          business_id: string
          can_post: boolean
          can_switch: boolean
          created_at: string
          id: string
          is_primary: boolean
          organization_id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id: string
          can_post?: boolean
          can_switch?: boolean
          created_at?: string
          id?: string
          is_primary?: boolean
          organization_id: string
          role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string
          can_post?: boolean
          can_switch?: boolean
          created_at?: string
          id?: string
          is_primary?: boolean
          organization_id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_business_access_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_business_access_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_business_access_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_business_access_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_business_module_permissions: {
        Row: {
          business_id: string
          can_create: boolean
          can_delete: boolean
          can_read: boolean
          can_write: boolean
          created_at: string
          id: string
          module: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          business_id: string
          can_create?: boolean
          can_delete?: boolean
          can_read?: boolean
          can_write?: boolean
          created_at?: string
          id?: string
          module: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          business_id?: string
          can_create?: boolean
          can_delete?: boolean
          can_read?: boolean
          can_write?: boolean
          created_at?: string
          id?: string
          module?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_business_module_permissions_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_business_module_permissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_business_module_permissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_business_module_permissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_command_preferences: {
        Row: {
          organization_id: string
          pinned: Json
          updated_at: string
          usage: Json
          user_id: string
        }
        Insert: {
          organization_id: string
          pinned?: Json
          updated_at?: string
          usage?: Json
          user_id: string
        }
        Update: {
          organization_id?: string
          pinned?: Json
          updated_at?: string
          usage?: Json
          user_id?: string
        }
        Relationships: []
      }
      user_devices: {
        Row: {
          browser: string | null
          browser_version: string | null
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          device_fingerprint: string
          device_name: string | null
          device_type: string | null
          first_seen_at: string
          id: string
          ip_address: unknown
          is_current: boolean
          is_trusted: boolean
          last_seen_at: string
          latitude: number | null
          longitude: number | null
          os: string | null
          os_version: string | null
          region: string | null
          session_count: number
          trust_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          browser?: string | null
          browser_version?: string | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          device_fingerprint: string
          device_name?: string | null
          device_type?: string | null
          first_seen_at?: string
          id?: string
          ip_address?: unknown
          is_current?: boolean
          is_trusted?: boolean
          last_seen_at?: string
          latitude?: number | null
          longitude?: number | null
          os?: string | null
          os_version?: string | null
          region?: string | null
          session_count?: number
          trust_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          browser?: string | null
          browser_version?: string | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          device_fingerprint?: string
          device_name?: string | null
          device_type?: string | null
          first_seen_at?: string
          id?: string
          ip_address?: unknown
          is_current?: boolean
          is_trusted?: boolean
          last_seen_at?: string
          latitude?: number | null
          longitude?: number | null
          os?: string | null
          os_version?: string | null
          region?: string | null
          session_count?: number
          trust_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "user_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_roles_profiles_fk"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_security_preferences: {
        Row: {
          biometric_enabled: boolean
          created_at: string
          id: string
          inactivity_timeout_minutes: number | null
          pin_enabled: boolean
          pin_required_for_unlock: boolean | null
          session_timeout_minutes: number
          updated_at: string
          user_id: string
        }
        Insert: {
          biometric_enabled?: boolean
          created_at?: string
          id?: string
          inactivity_timeout_minutes?: number | null
          pin_enabled?: boolean
          pin_required_for_unlock?: boolean | null
          session_timeout_minutes?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          biometric_enabled?: boolean
          created_at?: string
          id?: string
          inactivity_timeout_minutes?: number | null
          pin_enabled?: boolean
          pin_required_for_unlock?: boolean | null
          session_timeout_minutes?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          event_id: string
          event_type: string
          id: string
          organization_id: string | null
          payload: Json | null
          processed_at: string
          provider: string
        }
        Insert: {
          event_id: string
          event_type: string
          id?: string
          organization_id?: string | null
          payload?: Json | null
          processed_at?: string
          provider: string
        }
        Update: {
          event_id?: string
          event_type?: string
          id?: string
          organization_id?: string | null
          payload?: Json | null
          processed_at?: string
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "webhook_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      analytic_distributions: {
        Row: {
          amount: number | null
          analytic_account_id: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string | null
          date: string | null
          description: string | null
          id: string | null
          journal_entry_id: string | null
          journal_entry_line_id: string | null
          organization_id: string | null
          percentage: number | null
          plan_id: string | null
          source_id: string | null
          source_type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entry_line_analytics_analytic_account_id_fkey"
            columns: ["analytic_account_id"]
            isOneToOne: false
            referencedRelation: "analytic_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["journal_entry_id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_id_fkey"
            columns: ["journal_entry_id"]
            isOneToOne: false
            referencedRelation: "v_je_source_consistency"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_line_id_fkey"
            columns: ["journal_entry_line_id"]
            isOneToOne: false
            referencedRelation: "ap_subledger_entries"
            referencedColumns: ["line_id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_journal_entry_line_id_fkey"
            columns: ["journal_entry_line_id"]
            isOneToOne: false
            referencedRelation: "journal_entry_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_line_analytics_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "analytic_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      ap_subledger_entries: {
        Row: {
          account_id: string | null
          branch_id: string | null
          business_id: string | null
          contact_id: string | null
          created_at: string | null
          credit: number | null
          currency: string | null
          debit: number | null
          entry_date: string | null
          entry_description: string | null
          entry_number: string | null
          journal_entry_id: string | null
          line_description: string | null
          line_id: string | null
          organization_id: string | null
          source_id: string | null
          source_type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "v_unidentified_system_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entry_lines_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      employees_active: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          avatar_url: string | null
          bank_account_number: string | null
          bank_branch: string | null
          bank_code: string | null
          bank_name: string | null
          branch_id: string | null
          business_id: string | null
          city: string | null
          cost_rate_override: number | null
          country: string | null
          county: string | null
          created_at: string | null
          created_by: string | null
          date_of_birth: string | null
          department_id: string | null
          draft_owner_id: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          employee_number: string | null
          employment_type: string | null
          external_attendance_ref: string | null
          first_name: string | null
          gender: string | null
          hire_date: string | null
          id: string | null
          is_active: boolean | null
          job_position_id: string | null
          labor_burden_pct: number | null
          last_name: string | null
          lifecycle_status:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id: string | null
          marital_status: string | null
          national_id: string | null
          organization_id: string | null
          other_allowances: Json | null
          personal_phone: string | null
          phone: string | null
          postal_code: string | null
          sms_consent: boolean | null
          sms_consent_recorded_at: string | null
          statutory_country_code: string | null
          termination_date: string | null
          updated_at: string | null
          user_access_status: string | null
          user_id: string | null
          work_email: string | null
          work_location_id: string | null
          work_schedule_id: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_number?: string | null
          bank_branch?: string | null
          bank_code?: string | null
          bank_name?: string | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          cost_rate_override?: number | null
          country?: string | null
          county?: string | null
          created_at?: string | null
          created_by?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          draft_owner_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number?: string | null
          employment_type?: string | null
          external_attendance_ref?: string | null
          first_name?: string | null
          gender?: string | null
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          job_position_id?: string | null
          labor_burden_pct?: number | null
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          marital_status?: string | null
          national_id?: string | null
          organization_id?: string | null
          other_allowances?: Json | null
          personal_phone?: string | null
          phone?: string | null
          postal_code?: string | null
          sms_consent?: boolean | null
          sms_consent_recorded_at?: string | null
          statutory_country_code?: string | null
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_number?: string | null
          bank_branch?: string | null
          bank_code?: string | null
          bank_name?: string | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          cost_rate_override?: number | null
          country?: string | null
          county?: string | null
          created_at?: string | null
          created_by?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          draft_owner_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number?: string | null
          employment_type?: string | null
          external_attendance_ref?: string | null
          first_name?: string | null
          gender?: string | null
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          job_position_id?: string | null
          labor_burden_pct?: number | null
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          marital_status?: string | null
          national_id?: string | null
          organization_id?: string | null
          other_allowances?: Json | null
          personal_phone?: string | null
          phone?: string | null
          postal_code?: string | null
          sms_consent?: boolean | null
          sms_consent_recorded_at?: string | null
          statutory_country_code?: string | null
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
          work_location_id?: string | null
          work_schedule_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_order_effective_kind_defaults: {
        Row: {
          aggregate_cap_membership:
            | Database["public"]["Enums"]["legal_order_cap_membership"]
            | null
          always_first: boolean | null
          calc_model:
            | Database["public"]["Enums"]["legal_order_calc_model"]
            | null
          counts_toward_aggregate_cap: boolean | null
          default_priority: number | null
          employer_fee_amount: number | null
          evidence_required: boolean | null
          kind: string | null
          label: string | null
          max_concurrent: number | null
          organization_id: string | null
          priority_class: number | null
          protected_earnings_rule: Json | null
          required_identifiers: Json | null
          source: string | null
          source_pack_id: string | null
        }
        Relationships: []
      }
      mf_client_exposure: {
        Row: {
          active_loan_count: number | null
          amount_overdue: number | null
          branch_id: string | null
          business_id: string | null
          client_id: string | null
          client_number: string | null
          client_status: string | null
          fees_outstanding: number | null
          full_name: string | null
          interest_outstanding: number | null
          loan_officer_id: string | null
          next_due_date: string | null
          principal_outstanding: number | null
          total_outstanding: number | null
          worst_days_past_due: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_clients_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_clients_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_client_statement: {
        Row: {
          amount_in: number | null
          amount_out: number | null
          branch_id: string | null
          business_id: string | null
          client_id: string | null
          currency_code: string | null
          description: string | null
          entry_date: string | null
          entry_id: string | null
          entry_type: string | null
          loan_id: string | null
          loan_number: string | null
          method: string | null
          reference: string | null
        }
        Relationships: []
      }
      mf_collections_by_branch: {
        Row: {
          amount_collected: number | null
          branch_id: string | null
          business_id: string | null
          cash_collected: number | null
          client_count: number | null
          mobile_money_collected: number | null
          other_collected: number | null
          paid_on: string | null
          receipt_count: number | null
        }
        Relationships: []
      }
      mf_collections_by_officer: {
        Row: {
          amount_collected: number | null
          branch_id: string | null
          business_id: string | null
          cash_collected: number | null
          client_count: number | null
          loan_officer_id: string | null
          mobile_money_collected: number | null
          other_collected: number | null
          paid_on: string | null
          receipt_count: number | null
        }
        Relationships: []
      }
      mf_loan_arrears: {
        Row: {
          arrears_amount: number | null
          balance_due: number | null
          branch_id: string | null
          business_id: string | null
          client_id: string | null
          days_past_due: number | null
          due_date: string | null
          fees_due: number | null
          installment_no: number | null
          interest_due: number | null
          loan_id: string | null
          loan_number: string | null
          loan_officer_id: string | null
          principal_due: number | null
          total_due: number | null
          total_paid: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_balances: {
        Row: {
          amount_overdue: number | null
          branch_id: string | null
          business_id: string | null
          client_id: string | null
          currency_code: string | null
          days_past_due: number | null
          fees_outstanding: number | null
          interest_outstanding: number | null
          loan_id: string | null
          loan_number: string | null
          loan_officer_id: string | null
          next_due_date: string | null
          principal: number | null
          principal_outstanding: number | null
          status: string | null
          total_contractual: number | null
          total_outstanding: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_client_exposure"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "mf_loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mf_clients"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_installment_status: {
        Row: {
          business_id: string | null
          due_date: string | null
          fees_due: number | null
          fees_outstanding: number | null
          fees_paid: number | null
          installment_no: number | null
          interest_due: number | null
          interest_outstanding: number | null
          interest_paid: number | null
          loan_id: string | null
          principal_due: number | null
          principal_outstanding: number | null
          principal_paid: number | null
          total_due: number | null
          total_outstanding: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_schedule_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_loan_penalty_status: {
        Row: {
          business_id: string | null
          installment_no: number | null
          loan_id: string | null
          penalty_charged: number | null
          penalty_outstanding: number | null
          penalty_paid: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_loan_charges_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_balances"
            referencedColumns: ["loan_id"]
          },
          {
            foreignKeyName: "mf_loan_charges_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "mf_loans"
            referencedColumns: ["id"]
          },
        ]
      }
      mf_par_aging: {
        Row: {
          branch_id: string | null
          bucket_1_30: number | null
          bucket_31_60: number | null
          bucket_61_90: number | null
          bucket_90_plus: number | null
          business_id: string | null
          current_outstanding: number | null
          loan_count: number | null
          loan_officer_id: string | null
          loans_in_arrears: number | null
          portfolio_outstanding: number | null
        }
        Relationships: []
      }
      mf_par_summary: {
        Row: {
          branch_id: string | null
          business_id: string | null
          loan_count: number | null
          loan_officer_id: string | null
          par_1: number | null
          par_1_ratio: number | null
          par_30: number | null
          par_30_ratio: number | null
          par_90: number | null
          par_90_ratio: number | null
          portfolio_outstanding: number | null
        }
        Relationships: []
      }
      mf_product_performance: {
        Row: {
          active_loan_count: number | null
          amount_overdue: number | null
          business_id: string | null
          closed_loan_count: number | null
          loan_count: number | null
          outstanding: number | null
          principal_contracted: number | null
          principal_disbursed: number | null
          product_code: string | null
          product_id: string | null
          product_name: string | null
          worst_days_past_due: number | null
          written_off_loan_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "mf_loans_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "mf_loan_products"
            referencedColumns: ["id"]
          },
        ]
      }
      org_health: {
        Row: {
          active_branches_count: number | null
          active_businesses_count: number | null
          has_primary_business: boolean | null
          health_status: string | null
          org_id: string | null
          org_name: string | null
          org_slug: string | null
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          accepted_at: string | null
          deactivated_at: string | null
          deactivated_by: string | null
          granted_at: string | null
          granted_by: string | null
          id: string | null
          invitation_status: string | null
          invitation_token: string | null
          invited_at: string | null
          invited_email: string | null
          is_active: boolean | null
          notes: string | null
          role: string | null
          user_id: string | null
        }
        Relationships: []
      }
      reversal_register: {
        Row: {
          action_key: string | null
          amount: number | null
          approval_request_id: string | null
          approval_status: string | null
          branch_id: string | null
          business_id: string | null
          currency: string | null
          document_date: string | null
          document_id: string | null
          document_number: string | null
          document_type: string | null
          module: string | null
          organization_id: string | null
          reason_code: string | null
          reason_comment: string | null
          reversal_date: string | null
          reversal_kind: string | null
          reversed_by: string | null
        }
        Relationships: []
      }
      sms_provider_configs_masked: {
        Row: {
          account_sid_masked: string | null
          auth_token_masked: string | null
          business_id: string | null
          created_at: string | null
          created_by: string | null
          id: string | null
          is_enabled: boolean | null
          messaging_service_sid: string | null
          organization_id: string | null
          provider: Database["public"]["Enums"]["sms_provider"] | null
          sender_phone: string | null
          updated_at: string | null
          webhook_url: string | null
        }
        Insert: {
          account_sid_masked?: never
          auth_token_masked?: never
          business_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string | null
          is_enabled?: boolean | null
          messaging_service_sid?: string | null
          organization_id?: string | null
          provider?: Database["public"]["Enums"]["sms_provider"] | null
          sender_phone?: string | null
          updated_at?: string | null
          webhook_url?: string | null
        }
        Update: {
          account_sid_masked?: never
          auth_token_masked?: never
          business_id?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string | null
          is_enabled?: boolean | null
          messaging_service_sid?: string | null
          organization_id?: string | null
          provider?: Database["public"]["Enums"]["sms_provider"] | null
          sender_phone?: string | null
          updated_at?: string | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_provider_configs_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_provider_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_webhook_health: {
        Row: {
          business_id: string | null
          inbound_24h: number | null
          last_inbound_at: string | null
          last_status_callback_at: string | null
          organization_id: string | null
          outbound_24h: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_log_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_branch_scoped_policy_check: {
        Row: {
          cmd: string | null
          has_branch_arm: boolean | null
          policy_text: string | null
          policyname: unknown
          tablename: unknown
        }
        Relationships: []
      }
      v_business_event_outbox_health: {
        Row: {
          failed_count: number | null
          oldest_pending_age_seconds: number | null
          org_id: string | null
          pending_over_5min: number | null
          stale_running: number | null
        }
        Relationships: []
      }
      v_employee_branch_scope: {
        Row: {
          branch_id: string | null
          employee_id: string | null
        }
        Relationships: []
      }
      v_employees_canonical: {
        Row: {
          avatar_url: string | null
          branch_ids: string[] | null
          business_id: string | null
          created_at: string | null
          department_id: string | null
          email: string | null
          employee_number: string | null
          employment_type: string | null
          first_name: string | null
          full_name: string | null
          hire_date: string | null
          id: string | null
          is_active: boolean | null
          is_operationally_active: boolean | null
          last_name: string | null
          lifecycle_status:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id: string | null
          organization_id: string | null
          phone: string | null
          primary_branch_id: string | null
          termination_date: string | null
          updated_at: string | null
          user_access_status: string | null
          user_id: string | null
          work_email: string | null
        }
        Insert: {
          avatar_url?: string | null
          branch_ids?: never
          business_id?: string | null
          created_at?: string | null
          department_id?: string | null
          email?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          full_name?: never
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          is_operationally_active?: never
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          organization_id?: string | null
          phone?: string | null
          primary_branch_id?: never
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Update: {
          avatar_url?: string | null
          branch_ids?: never
          business_id?: string | null
          created_at?: string | null
          department_id?: string | null
          email?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          full_name?: never
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          is_operationally_active?: never
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          organization_id?: string | null
          phone?: string | null
          primary_branch_id?: never
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_employees_safe: {
        Row: {
          avatar_url: string | null
          branch_ids: string[] | null
          business_id: string | null
          created_at: string | null
          department_id: string | null
          email: string | null
          employee_number: string | null
          employment_type: string | null
          first_name: string | null
          full_name: string | null
          hire_date: string | null
          id: string | null
          is_active: boolean | null
          is_operationally_active: boolean | null
          last_name: string | null
          lifecycle_status:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id: string | null
          organization_id: string | null
          phone: string | null
          primary_branch_id: string | null
          termination_date: string | null
          updated_at: string | null
          user_access_status: string | null
          user_id: string | null
          work_email: string | null
        }
        Insert: {
          avatar_url?: string | null
          branch_ids?: never
          business_id?: string | null
          created_at?: string | null
          department_id?: string | null
          email?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          full_name?: never
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          is_operationally_active?: never
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          organization_id?: string | null
          phone?: string | null
          primary_branch_id?: never
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Update: {
          avatar_url?: string | null
          branch_ids?: never
          business_id?: string | null
          created_at?: string | null
          department_id?: string | null
          email?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          full_name?: never
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          is_operationally_active?: never
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          organization_id?: string | null
          phone?: string | null
          primary_branch_id?: never
          termination_date?: string | null
          updated_at?: string | null
          user_access_status?: string | null
          user_id?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_fiscal_workspace_health: {
        Row: {
          failing_count: number | null
          last_activity_at: string | null
          last_success_at: string | null
          organization_id: string | null
          pending_count: number | null
          provider_key: string | null
          succeeded_count: number | null
        }
        Relationships: []
      }
      v_hr_headcount_by_department: {
        Row: {
          business_id: string | null
          department_id: string | null
          department_name: string | null
          headcount: number | null
          organization_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_hr_headcount_snapshot: {
        Row: {
          active_count: number | null
          branch_id: string | null
          business_id: string | null
          contract_count: number | null
          department_id: string | null
          department_name: string | null
          full_time_count: number | null
          inactive_count: number | null
          organization_id: string | null
          part_time_count: number | null
          snapshot_date: string | null
          total_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_hr_turnover_rolling_12m: {
        Row: {
          active_now: number | null
          branch_id: string | null
          business_id: string | null
          department_id: string | null
          hires_12m: number | null
          organization_id: string | null
          terminations_12m: number | null
          total_now: number | null
          turnover_pct: number | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_identity_invariants_violations: {
        Row: {
          business_id: string | null
          employee_id: string | null
          organization_id: string | null
          user_id: string | null
          violation: string | null
        }
        Relationships: []
      }
      v_je_source_consistency: {
        Row: {
          description: string | null
          entry_date: string | null
          entry_number: string | null
          id: string | null
          issue: string | null
          organization_id: string | null
          reference: string | null
          source_id: string | null
          source_subtype: string | null
          source_type: string | null
        }
        Insert: {
          description?: string | null
          entry_date?: string | null
          entry_number?: string | null
          id?: string | null
          issue?: never
          organization_id?: string | null
          reference?: string | null
          source_id?: string | null
          source_subtype?: string | null
          source_type?: string | null
        }
        Update: {
          description?: string | null
          entry_date?: string | null
          entry_number?: string | null
          id?: string | null
          issue?: never
          organization_id?: string | null
          reference?: string | null
          source_id?: string | null
          source_subtype?: string | null
          source_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "journal_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
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
      v_my_employee_profile: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          avatar_url: string | null
          bank_account_masked: string | null
          bank_branch: string | null
          bank_name: string | null
          branch_id: string | null
          business_id: string | null
          city: string | null
          country: string | null
          county: string | null
          date_of_birth: string | null
          department_id: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relationship: string | null
          employee_number: string | null
          employment_type: string | null
          first_name: string | null
          gender: string | null
          hire_date: string | null
          id: string | null
          is_active: boolean | null
          job_position_id: string | null
          last_name: string | null
          lifecycle_status:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id: string | null
          marital_status: string | null
          national_id_masked: string | null
          organization_id: string | null
          personal_phone: string | null
          phone: string | null
          postal_code: string | null
          work_email: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_masked?: never
          bank_branch?: string | null
          bank_name?: string | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          country?: string | null
          county?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          gender?: string | null
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          job_position_id?: string | null
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          marital_status?: string | null
          national_id_masked?: never
          organization_id?: string | null
          personal_phone?: string | null
          phone?: string | null
          postal_code?: string | null
          work_email?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bank_account_masked?: never
          bank_branch?: string | null
          bank_name?: string | null
          branch_id?: string | null
          business_id?: string | null
          city?: string | null
          country?: string | null
          county?: string | null
          date_of_birth?: string | null
          department_id?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relationship?: string | null
          employee_number?: string | null
          employment_type?: string | null
          first_name?: string | null
          gender?: string | null
          hire_date?: string | null
          id?: string | null
          is_active?: boolean | null
          job_position_id?: string | null
          last_name?: string | null
          lifecycle_status?:
            | Database["public"]["Enums"]["employee_lifecycle_status"]
            | null
          manager_id?: string | null
          marital_status?: string | null
          national_id_masked?: never
          organization_id?: string | null
          personal_phone?: string | null
          phone?: string | null
          postal_code?: string | null
          work_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employees_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_canonical"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_employees_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "v_my_employee_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "employees_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      v_unidentified_system_accounts: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"] | null
          business_id: string | null
          code: string | null
          detail_type: string | null
          id: string | null
          is_system: boolean | null
          name: string | null
          organization_id: string | null
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          business_id?: string | null
          code?: string | null
          detail_type?: string | null
          id?: string | null
          is_system?: boolean | null
          name?: string | null
          organization_id?: string | null
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          business_id?: string | null
          code?: string | null
          detail_type?: string | null
          id?: string | null
          is_system?: boolean | null
          name?: string | null
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounts_business_id_fkey"
            columns: ["business_id"]
            isOneToOne: false
            referencedRelation: "businesses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "legal_order_effective_kind_defaults"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "org_health"
            referencedColumns: ["org_id"]
          },
          {
            foreignKeyName: "accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      __ts_wave5_record: { Args: { _r: Json }; Returns: undefined }
      __ts_wave5_seed_ids: {
        Args: {
          _biz: string
          _first: string
          _hire: string
          _last: string
          _mgr: string
          _num: string
          _org: string
          _user: string
        }
        Returns: string
      }
      __v1_probe_disburse: {
        Args: { p_amount: number; p_loan: string }
        Returns: Json
      }
      _account_is_postable: {
        Args: { p_account_id: string; p_business_id: string; p_org_id: string }
        Returns: boolean
      }
      _approval_match_rule: {
        Args: {
          _action_key: string
          _business: string
          _entity_type: string
          _org: string
          _payload: Json
        }
        Returns: {
          action_name: string
          approval_mode: string
          approver_role: string | null
          approver_type: string
          approver_user_id: string | null
          business_id: string | null
          condition: Json | null
          created_at: string
          created_by: string | null
          description: string | null
          entity_type: string
          id: string
          is_active: boolean
          organization_id: string
          requires_review: boolean
          requires_review_reason: string | null
          threshold_field: string | null
          threshold_operator: string | null
          threshold_value: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "approval_rules"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _approval_role_matches: {
        Args: { _org: string; _role: string; _user: string }
        Returns: boolean
      }
      _assert_can_read_bank_history: {
        Args: { _branch_id: string; _business_id: string }
        Returns: undefined
      }
      _assert_currency_is_active: {
        Args: { _code: string }
        Returns: undefined
      }
      _assert_expense_account_postable: {
        Args: { p_account_id: string; p_label: string }
        Returns: undefined
      }
      _assert_org_member: { Args: { p_org: string }; Returns: undefined }
      _assert_reset_permission: { Args: { org_id: string }; Returns: undefined }
      _bank_account_movement: {
        Args: { _as_of: string; _bank_account_id: string; _session_id?: string }
        Returns: {
          cleared_count: number
          cleared_net: number
          last_line_date: string
          net_amount: number
          unreconciled_amount: number
          unreconciled_count: number
        }[]
      }
      _bank_account_post_opening_balance: {
        Args: { _account_id: string }
        Returns: string
      }
      _bank_account_row: { Args: { _id: string }; Returns: Json }
      _bank_doc_is_spoken_for: {
        Args: { _doc_id: string; _kind: string }
        Returns: boolean
      }
      _bank_history_actor: { Args: { _user_id: string }; Returns: string }
      _bank_match_history_row: {
        Args: {
          _m: Database["public"]["Tables"]["bank_reconciliation_matches"]["Row"]
        }
        Returns: Json
      }
      _bank_match_validate: {
        Args: {
          _allocations: Json
          _fee_amount: number
          _txn: Database["public"]["Tables"]["bank_transactions"]["Row"]
        }
        Returns: string
      }
      _bank_recon_closed_session: {
        Args: { _bank_account_id: string; _txn_date: string }
        Returns: string
      }
      _bank_reconciliation_assert_account: {
        Args: { _bank_account_id: string }
        Returns: {
          access_token_encrypted: string | null
          account_id: string | null
          account_number: string | null
          account_type: string | null
          activated_at: string | null
          auto_sync_enabled: boolean | null
          bank_balance_as_of: string | null
          bank_name: string | null
          bank_reported_balance: number | null
          branch_id: string | null
          business_id: string | null
          closed_at: string | null
          closed_reason: string | null
          created_at: string
          currency: string
          current_balance: number | null
          external_account_id: string | null
          id: string
          is_active: boolean
          is_primary: boolean | null
          is_shared: boolean
          last_auto_sync_at: string | null
          lifecycle_status: Database["public"]["Enums"]["bank_account_lifecycle_status"]
          name: string
          opening_balance: number
          opening_balance_date: string | null
          opening_balance_je_id: string | null
          organization_id: string
          provider_id: string | null
          refresh_token_encrypted: string | null
          routing_number: string | null
          row_version: number
          sync_frequency: string | null
          sync_from_date: string | null
          token_expires_at: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bank_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _bank_reconciliation_gl_tieout: {
        Args: { _session_id: string }
        Returns: Json
      }
      _bank_reconciliation_recompute: {
        Args: { _session_id: string }
        Returns: Json
      }
      _budget_assert_manage: {
        Args: { _budget_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string | null
          budget_code: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string | null
          description: string | null
          fiscal_year: number
          id: string
          name: string
          organization_id: string
          status: Database["public"]["Enums"]["budget_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "budgets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _budget_assert_read: {
        Args: { _budget_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string | null
          budget_code: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string | null
          description: string | null
          fiscal_year: number
          id: string
          name: string
          organization_id: string
          status: Database["public"]["Enums"]["budget_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "budgets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _consolidation_fy_start: {
        Args: { _business_id: string; _on_date: string }
        Returns: string
      }
      _consolidation_seed_default_rules: {
        Args: { _group_id: string }
        Returns: number
      }
      _consolidation_validate_tolerance: {
        Args: {
          _difference_group_account_id: string
          _difference_policy: string
          _presentation_currency: string
          _tolerance_amount: number
          _tolerance_percent: number
          _tolerance_reason: string
        }
        Returns: undefined
      }
      _crm_assert_transition: {
        Args: {
          p_from: Database["public"]["Enums"]["crm_lead_status"]
          p_reopen?: boolean
          p_to: Database["public"]["Enums"]["crm_lead_status"]
        }
        Returns: undefined
      }
      _crm_assert_version: {
        Args: { p_actual: number; p_expected: number }
        Returns: undefined
      }
      _default_receipt_settings: { Args: never; Returns: Json }
      _document_snapshot_fingerprint: {
        Args: { p_snapshot: Json }
        Returns: string
      }
      _eba_sync_primary_to_employees: {
        Args: { p_employee_id: string }
        Returns: undefined
      }
      _execute_organization_delete: {
        Args: { _job_id: string; _org_id: string }
        Returns: undefined
      }
      _expense_apply_approval: {
        Args: { p_actor: string; p_expense_id: string }
        Returns: Json
      }
      _expense_guard: {
        Args: { p_allowed: string[]; p_expense_id: string }
        Returns: {
          account_id: string | null
          amount: number
          analytic_account_id: string | null
          approval_request_id: string | null
          approved_at: string | null
          approved_by: string | null
          base_amount: number | null
          branch_id: string | null
          business_id: string
          category_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          department_id: string | null
          description: string
          employee_id: string | null
          exchange_rate: number
          expense_date: string
          expense_number: string | null
          id: string
          is_billable: boolean | null
          is_sample_data: boolean
          journal_entry_id: string | null
          organization_id: string
          paid_by: string
          payment_account_id: string | null
          payment_method: string
          receipt_url: string | null
          reference: string | null
          reimburse_via_payroll: boolean
          reimbursed_at: string | null
          reimbursed_payslip_id: string | null
          reimbursed_run_id: string | null
          rejected_reason: string | null
          status: Database["public"]["Enums"]["expense_status"]
          submitted_at: string | null
          submitted_by: string | null
          task_id: string | null
          tax_amount: number | null
          tax_rate_id: string | null
          tax_treatment: string
          updated_at: string
          vendor_id: string | null
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "expenses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _expense_payable_account: {
        Args: { p_expense_id: string }
        Returns: string
      }
      _expense_reimbursement_guard: {
        Args: { p_expense_id: string }
        Returns: {
          account_id: string | null
          amount: number
          analytic_account_id: string | null
          approval_request_id: string | null
          approved_at: string | null
          approved_by: string | null
          base_amount: number | null
          branch_id: string | null
          business_id: string
          category_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          department_id: string | null
          description: string
          employee_id: string | null
          exchange_rate: number
          expense_date: string
          expense_number: string | null
          id: string
          is_billable: boolean | null
          is_sample_data: boolean
          journal_entry_id: string | null
          organization_id: string
          paid_by: string
          payment_account_id: string | null
          payment_method: string
          receipt_url: string | null
          reference: string | null
          reimburse_via_payroll: boolean
          reimbursed_at: string | null
          reimbursed_payslip_id: string | null
          reimbursed_run_id: string | null
          rejected_reason: string | null
          status: Database["public"]["Enums"]["expense_status"]
          submitted_at: string | null
          submitted_by: string | null
          task_id: string | null
          tax_amount: number | null
          tax_rate_id: string | null
          tax_treatment: string
          updated_at: string
          vendor_id: string | null
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "expenses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _fx_document_is_posted: {
        Args: { p_id: string; p_source_type: string }
        Returns: boolean
      }
      _fx_document_is_posted_any: {
        Args: { p_id: string; p_source_types: string[] }
        Returns: boolean
      }
      _fx_reval_lock_key: {
        Args: { _business_id: string; _scope: string }
        Returns: number
      }
      _is_teardown_active: { Args: never; Returns: boolean }
      _is_teardown_for_org: { Args: { p_org: string }; Returns: boolean }
      _landed_cost_annotate_reversal_intent: {
        Args: { _intent: Json }
        Returns: Json
      }
      _loan_close_approval_request: {
        Args: { _action: string; _loan_id: string; _notes: string }
        Returns: undefined
      }
      _loan_lifecycle_emit: {
        Args: {
          _actor: string
          _event: string
          _loan_id: string
          _payload: Json
        }
        Returns: undefined
      }
      _loan_record_bank_movement: {
        Args: {
          _amount: number
          _branch: string
          _business: string
          _description: string
          _direction: string
          _external_key: string
          _gl_account_id: string
          _je_id: string
          _org: string
          _reference: string
          _value_date: string
        }
        Returns: string
      }
      _loan_resolve_account: {
        Args: {
          _branch: string
          _business: string
          _org: string
          _override: string
          _setting_key: string
        }
        Returns: string
      }
      _loan_resolve_business: {
        Args: { _employee_id: string; _org: string; _supplied: string }
        Returns: string
      }
      _pc_emit: {
        Args: {
          _contract_id: string
          _org: string
          _payload?: Json
          _state: string
          _suffix?: string
        }
        Returns: undefined
      }
      _pc_snapshot_version: {
        Args: { _contract_id: string; _effective_from: string }
        Returns: number
      }
      _pick_exchange_rate_row: {
        Args: {
          p_base_currency: string
          p_business_id: string
          p_currency: string
          p_on_date: string
          p_org_id: string
        }
        Returns: {
          effective_date: string
          provider_key: string
          rate: number
          scope: string
          source: string
        }[]
      }
      _pick_hq_branch: { Args: { _business_id: string }; Returns: string }
      _pr_lifecycle_active: { Args: never; Returns: boolean }
      _pr_lifecycle_begin: { Args: never; Returns: undefined }
      _pret_lifecycle_begin: { Args: never; Returns: undefined }
      _primary_business_for_org: { Args: { _org: string }; Returns: string }
      _project_assert_currency: {
        Args: {
          _business_id: string
          _currency: string
          _organization_id: string
        }
        Returns: undefined
      }
      _project_has_financial_activity: {
        Args: { _project_id: string }
        Returns: boolean
      }
      _project_id_for_task: { Args: { _task_id: string }; Returns: string }
      _raise_business_required: { Args: never; Returns: string }
      _recurring_bump_definition_version: {
        Args: { _recurring_id: string; _user_id: string }
        Returns: undefined
      }
      _recurring_complete_if_finished: {
        Args: { _next_start: string; _recurring_id: string }
        Returns: undefined
      }
      _resolve_account_detail_type: {
        Args: {
          _account_type: string
          _role_key: string
          _supplied_detail_type: string
        }
        Returns: string
      }
      _resolve_canonical_default_account: {
        Args: {
          p_as_of?: string
          p_branch_id?: string
          p_business_id: string
          p_org_id: string
          p_setting_key: string
        }
        Returns: string
      }
      _resolve_supplier_role_id: {
        Args: { p_business_id: string; p_party_or_role_id: string }
        Returns: string
      }
      _rtest: {
        Args: { _detail?: string; _name: string; _passed: boolean }
        Returns: Json
      }
      _scanner_hash_trust_token: { Args: { p_token: string }; Returns: string }
      _so_write_cancelled_quantities: {
        Args: { p_so_id: string }
        Returns: undefined
      }
      _sod_is_approved_status: { Args: { s: string }; Returns: boolean }
      _talent_guard_on: { Args: never; Returns: boolean }
      _talent_notify: {
        Args: {
          _biz: string
          _entity_id: string
          _entity_type: string
          _kind: string
          _link: string
          _message: string
          _org: string
          _priority?: number
          _title: string
          _user_id: string
        }
        Returns: undefined
      }
      _teardown_allows: { Args: { p_row: Json }; Returns: boolean }
      _timesheet_assert_project_eligibility: {
        Args: { _employee_id: string; _project_id: string }
        Returns: undefined
      }
      _timesheet_can_amend: {
        Args: {
          _business_id: string
          _employee_id: string
          _org_id: string
          _uid: string
        }
        Returns: boolean
      }
      _timesheet_emit_event: {
        Args: {
          _branch_id?: string
          _event_type: string
          _idempotency_key: string
          _org_id: string
          _payload: Json
          _source_doc_id: string
          _source_doc_type: string
        }
        Returns: undefined
      }
      _timesheet_is_project_manager: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      _upsert_default_account_setting: {
        Args: {
          _account_id: string
          _branch_id: string
          _business_id: string
          _org_id: string
          _origin_pack_id?: string
          _origin_pack_version?: string
          _overridden_by?: string
          _override_reason?: string
          _setting_key: string
          _source?: string
        }
        Returns: undefined
      }
      _user_has_active_tenant_role: {
        Args: { p_user: string }
        Returns: boolean
      }
      _user_is_active_platform_admin: {
        Args: { p_user: string }
        Returns: boolean
      }
      accept_organization_invitation_atomic: {
        Args: {
          p_invitation_id: string
          p_permission_group_ids?: string[]
          p_user_id: string
        }
        Returns: Json
      }
      accept_ownership_transfer: {
        Args: { p_transfer_id: string }
        Returns: undefined
      }
      accounting_post_event: {
        Args: { p_event_id: string; p_idempotency_key?: string }
        Returns: Json
      }
      acknowledge_employee_document: {
        Args: { _document_id: string }
        Returns: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          branch_id: string | null
          business_id: string | null
          created_at: string
          description: string | null
          document_type: string
          employee_id: string
          expiry_date: string | null
          file_name: string | null
          file_path: string | null
          file_size: number | null
          id: string
          is_verified: boolean | null
          mime_type: string | null
          name: string
          organization_id: string
          updated_at: string
          uploaded_by: string | null
          verified_at: string | null
          verified_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "employee_documents"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      acknowledge_pack_upgrade_diff: {
        Args: { _proposal_id: string }
        Returns: Json
      }
      advance_cycle_count_next_run: {
        Args: { _cadence: string; _from: string }
        Returns: string
      }
      app_state_for_org: {
        Args: { _app_id: string; _org_id: string }
        Returns: string
      }
      apply_customer_deposit_atomic: {
        Args: {
          _amount: number
          _apply_date: string
          _client_request_id: string
          _invoice_id: string
          _payment_id: string
        }
        Returns: string
      }
      apply_pack_upgrade_atomic: {
        Args: { _proposal_id: string }
        Returns: Json
      }
      apply_reconciliation_rules: {
        Args: {
          _bank_account_id: string
          _max_rows?: number
          _user_id?: string
        }
        Returns: Json
      }
      approval_can_decide: {
        Args: { _request_id: string; _user: string }
        Returns: boolean
      }
      approval_decide: {
        Args: {
          _client_token?: string
          _comment?: string
          _decision: string
          _request_id: string
        }
        Returns: {
          action_key: string | null
          business_id: string | null
          completed_at: string | null
          context_snapshot: Json
          created_at: string
          current_step: number | null
          dedupe_hash: string | null
          entity_id: string
          entity_reference: string | null
          entity_type: string
          id: string
          idempotency_key: string | null
          notes: string | null
          organization_id: string
          payload_snapshot: Json
          policy_version: number | null
          requested_at: string | null
          requested_by: string | null
          rule_snapshot: Json | null
          status: string | null
          total_steps: number
          updated_at: string
          workflow_id: string | null
          workflow_snapshot: Json | null
          workflow_version: number | null
        }
        SetofOptions: {
          from: "*"
          to: "approval_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approval_history_verify: {
        Args: { _request_id: string }
        Returns: {
          event_seq: number
          ok: boolean
          reason: string
        }[]
      }
      approval_route: {
        Args: {
          _action_key: string
          _business_id?: string
          _context?: Json
          _entity_id: string
          _entity_reference?: string
          _entity_type: string
          _idempotency_key?: string
          _payload?: Json
        }
        Returns: {
          action_key: string | null
          business_id: string | null
          completed_at: string | null
          context_snapshot: Json
          created_at: string
          current_step: number | null
          dedupe_hash: string | null
          entity_id: string
          entity_reference: string | null
          entity_type: string
          id: string
          idempotency_key: string | null
          notes: string | null
          organization_id: string
          payload_snapshot: Json
          policy_version: number | null
          requested_at: string | null
          requested_by: string | null
          rule_snapshot: Json | null
          status: string | null
          total_steps: number
          updated_at: string
          workflow_id: string | null
          workflow_snapshot: Json | null
          workflow_version: number | null
        }
        SetofOptions: {
          from: "*"
          to: "approval_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_expense: {
        Args: { p_expense_id: string }
        Returns: {
          account_id: string | null
          amount: number
          analytic_account_id: string | null
          approval_request_id: string | null
          approved_at: string | null
          approved_by: string | null
          base_amount: number | null
          branch_id: string | null
          business_id: string
          category_id: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          department_id: string | null
          description: string
          employee_id: string | null
          exchange_rate: number
          expense_date: string
          expense_number: string | null
          id: string
          is_billable: boolean | null
          is_sample_data: boolean
          journal_entry_id: string | null
          organization_id: string
          paid_by: string
          payment_account_id: string | null
          payment_method: string
          receipt_url: string | null
          reference: string | null
          reimburse_via_payroll: boolean
          reimbursed_at: string | null
          reimbursed_payslip_id: string | null
          reimbursed_run_id: string | null
          rejected_reason: string | null
          status: Database["public"]["Enums"]["expense_status"]
          submitted_at: string | null
          submitted_by: string | null
          task_id: string | null
          tax_amount: number | null
          tax_rate_id: string | null
          tax_treatment: string
          updated_at: string
          vendor_id: string | null
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "expenses"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_journal_entry: {
        Args: { p_je_id: string }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          auto_reverse_date: string | null
          branch_id: string | null
          business_id: string
          created_at: string
          created_by: string | null
          currency: string
          description: string | null
          drill_down_data: Json | null
          entry_date: string
          entry_number: string
          exchange_rate: number | null
          fiscal_period_id: string | null
          id: string
          is_adjusting: boolean | null
          is_adjusting_entry: boolean
          is_closing: boolean | null
          is_closing_entry: boolean | null
          is_opening_entry: boolean | null
          is_reversal: boolean
          is_reversing: boolean | null
          is_sample_data: boolean
          journal_book_id: string | null
          organization_id: string
          posted_at: string | null
          posted_by: string | null
          posted_by_id: string | null
          reference: string | null
          reversal_of_id: string | null
          reversed_at: string | null
          reversed_by_id: string | null
          reversed_entry_id: string | null
          reversed_reason: string | null
          source_doc_id: string | null
          source_doc_type: string | null
          source_id: string | null
          source_module: string | null
          source_subtype: string | null
          source_type: string | null
          status: Database["public"]["Enums"]["journal_status"]
          submitted_at: string | null
          submitted_by: string | null
          total_credit: number
          total_debit: number
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "journal_entries"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_payment: {
        Args: { p_payment_id: string }
        Returns: {
          amount: number
          applied_amount: number
          approved_at: string | null
          approved_by: string | null
          bank_account_id: string | null
          branch_id: string | null
          business_id: string
          client_request_id: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          deposit_account_id: string | null
          direction: Database["public"]["Enums"]["payment_direction"]
          id: string
          is_sample_data: boolean
          journal_entry_id: string | null
          method: string | null
          migration_session_id: string | null
          notes: string | null
          organization_id: string
          outstanding_amount: number
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          reapplied_at: string | null
          reapplied_by: string | null
          reapply_reason: string | null
          receipt_number: string | null
          reference: string | null
          reversal_reason:
            | Database["public"]["Enums"]["payment_reversal_reason"]
            | null
          status: string | null
          submitted_at: string | null
          submitted_by: string | null
          unreconcile_reason: string | null
          unreconciled_at: string | null
          unreconciled_by: string | null
          updated_at: string
          void_reason: string | null
          void_reason_code: string | null
          voided_at: string | null
          voided_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "payments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      approve_supplier: {
        Args: { p_notes?: string; p_supplier_id: string }
        Returns: Json
      }
      archive_department: {
        Args: { _department_id: string; _reason?: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          branch_id: string | null
          business_id: string
          code: string | null
          created_at: string | null
          description: string | null
          dissolved_at: string | null
          dissolved_by: string | null
          id: string
          is_active: boolean | null
          manager_id: string | null
          name: string
          organization_id: string
          parent_department_id: string | null
          status: Database["public"]["Enums"]["department_status"]
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "departments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      archive_employee: { Args: { p_employee_id: string }; Returns: boolean }
      archive_supplier: {
        Args: { p_reason?: string; p_supplier_id: string }
        Returns: Json
      }
      assert_account_in_business: {
        Args: {
          _account_id: string
          _business_id: string
          _expected_detail_type?: string
          _label?: string
          _organization_id: string
        }
        Returns: undefined
      }
      assert_approval_action_keys_registered: {
        Args: never
        Returns: undefined
      }
      assert_can_manage_assets: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_manage_bank_accounts: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_manage_budgets: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_manage_coa: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_manage_je:
        | { Args: { _business_id: string }; Returns: undefined }
        | {
            Args: { _business_id: string; _caller: string }
            Returns: undefined
          }
      assert_can_manage_periods: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_reconcile_bank: {
        Args: { _business_id: string }
        Returns: undefined
      }
      assert_can_reverse: {
        Args: {
          _actor?: string
          _document_id: string
          _document_type: string
          _effective_date?: string
          _operation: string
        }
        Returns: Json
      }
      assert_can_view_dashboard_scope: {
        Args: { _branch_id: string; _business_id: string; _kind: string }
        Returns: undefined
      }
      assert_can_void_je:
        | { Args: { _business_id: string }; Returns: undefined }
        | {
            Args: { _business_id: string; _caller: string }
            Returns: undefined
          }
      assert_contact_in_business: {
        Args: {
          _business_id: string
          _contact_id: string
          _label?: string
          _organization_id: string
        }
        Returns: undefined
      }
      assert_entitlement: {
        Args: { p_app_id: string; p_org_id: string }
        Returns: boolean
      }
      assert_localization_pack_for_org: {
        Args: { p_org_id: string }
        Returns: undefined
      }
      assert_no_existing_source_posting: {
        Args: {
          _organization_id: string
          _source_id: string
          _source_subtype?: string
          _source_type: string
        }
        Returns: undefined
      }
      assert_no_receipt_cost_basis_as_money: { Args: never; Returns: undefined }
      assert_org_not_locked: { Args: { _org_id: string }; Returns: undefined }
      assert_reversal_reason: {
        Args: {
          _comment?: string
          _document_type: string
          _reason_code: string
        }
        Returns: undefined
      }
      assert_trial_balance: {
        Args: { p_as_of?: string; p_business_id: string }
        Returns: undefined
      }
      assign_employee_to_branch: {
        Args: {
          p_assignment_type?: string
          p_branch_id: string
          p_effective_from?: string
          p_employee_id: string
          p_is_primary?: boolean
          p_notes?: string
        }
        Returns: string
      }
      audit_system_account_writer_allowlist: {
        Args: never
        Returns: {
          function_name: string
          reason: string
          signature: string
        }[]
      }
      auto_create_replenishment_po: { Args: never; Returns: Json }
      backfill_account_detail_types: {
        Args: { _business_id?: string; _org_id?: string }
        Returns: number
      }
      bank_account_create: {
        Args: { _business_id: string; _payload: Json }
        Returns: Json
      }
      bank_account_delete_draft: {
        Args: { _id: string; _row_version?: number }
        Returns: undefined
      }
      bank_account_positions: {
        Args: { _as_of?: string; _business_id: string }
        Returns: {
          as_of: string
          bank_account_id: string
          currency: string
          gl_balance: number
          gl_shared: boolean
          last_statement_line_date: string
          opening_balance: number
          statement_balance: number
          unreconciled_amount: number
          unreconciled_count: number
        }[]
      }
      bank_account_reset_opening_balances: {
        Args: { _business_id: string }
        Returns: number
      }
      bank_account_transition: {
        Args: {
          _id: string
          _reason?: string
          _row_version?: number
          _target: Database["public"]["Enums"]["bank_account_lifecycle_status"]
        }
        Returns: Json
      }
      bank_account_update: {
        Args: { _id: string; _payload: Json; _row_version: number }
        Returns: Json
      }
      bank_feed_connection_resolve: {
        Args: { _bank_account_id: string; _user_id?: string }
        Returns: {
          auto_sync_enabled: boolean
          bank_account_id: string
          business_id: string
          config: Json
          consecutive_failures: number
          created_at: string
          created_by: string | null
          external_account_id: string | null
          id: string
          last_error: string | null
          last_run_at: string | null
          last_success_at: string | null
          organization_id: string
          provider_code: string
          provider_id: string | null
          status: string
          sync_frequency: string
          sync_from_date: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bank_feed_connections"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bank_match_candidates: {
        Args: { _limit?: number; _txn_id: string }
        Returns: Json
      }
      bank_match_confirm: {
        Args: {
          _client_request_id?: string
          _match_id: string
          _user_id?: string
        }
        Returns: Json
      }
      bank_match_history: {
        Args: { p_bank_transaction_id: string }
        Returns: Json
      }
      bank_match_propose: {
        Args: {
          _allocations: Json
          _fee_amount?: number
          _match_type?: string
          _notes?: string
          _rule_id?: string
          _txn_id: string
          _user_id?: string
        }
        Returns: Json
      }
      bank_match_reject: {
        Args: { _match_id: string; _reason?: string; _user_id?: string }
        Returns: Json
      }
      bank_match_reverse: {
        Args: { _match_id: string; _reason?: string; _user_id?: string }
        Returns: Json
      }
      bank_match_session_history: {
        Args: { p_session_id: string }
        Returns: Json
      }
      bank_reconciliation_item_set: {
        Args: {
          _cleared: boolean
          _session_id: string
          _transaction_id: string
        }
        Returns: Json
      }
      bank_reconciliation_rule_delete: {
        Args: { _id: string }
        Returns: undefined
      }
      bank_reconciliation_rule_upsert: {
        Args: { _business_id: string; _id?: string; _payload: Json }
        Returns: string
      }
      bank_reconciliation_session_cancel: {
        Args: { _reason?: string; _session_id: string }
        Returns: Json
      }
      bank_reconciliation_session_complete: {
        Args: { _session_id: string }
        Returns: Json
      }
      bank_reconciliation_session_reopen: {
        Args: { _reason: string; _session_id: string }
        Returns: Json
      }
      bank_reconciliation_session_start: {
        Args: {
          _adjustments?: Json
          _bank_account_id: string
          _closing_balance: number
          _opening_balance: number
          _statement_date: string
        }
        Returns: Json
      }
      bank_reconciliation_session_writeoff: {
        Args: { _max_amount?: number; _session_id: string }
        Returns: Json
      }
      bank_statement_import_batch: {
        Args: {
          _bank_account_id: string
          _rows: Json
          _source?: string
          _statement?: Json
        }
        Returns: Json
      }
      bank_transaction_apply_rules: {
        Args: {
          _amount: number
          _bank_account_id: string
          _business_id: string
          _description: string
          _organization_id: string
          _reference: string
          _transaction_type: string
        }
        Returns: Json
      }
      bank_transaction_fingerprint: {
        Args: {
          _amount: number
          _bank_account_id: string
          _description: string
          _reference: string
          _txn_date: string
        }
        Returns: string
      }
      bank_transaction_set_category: {
        Args: {
          _category: string
          _confidence?: number
          _transaction_ids: string[]
        }
        Returns: Json
      }
      bank_unmatch_preflight: {
        Args: { _bank_transaction_id: string }
        Returns: Json
      }
      bill_payment_is_bank_reconciled: {
        Args: { _bill_payment_id: string }
        Returns: boolean
      }
      block_supplier: {
        Args: { p_reason: string; p_supplier_id: string }
        Returns: Json
      }
      budget_fiscal_months: {
        Args: { _business_id: string; _fiscal_year: number }
        Returns: {
          end_date: string
          period_id: string
          period_month: number
          period_ordinal: number
          start_date: string
          status: string
        }[]
      }
      calculate_project_progress: {
        Args: { p_project_id: string }
        Returns: number
      }
      can_access_ai_conversation_scope: {
        Args: {
          _branch_id: string
          _business_id: string
          _organization_id: string
          _user_id: string
        }
        Returns: boolean
      }
      can_access_branch: {
        Args: { _branch_id: string; _user_id: string }
        Returns: boolean
      }
      can_access_pos_scan_channel: {
        Args: { p_topic: string }
        Returns: boolean
      }
      can_access_project: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      can_access_scan_channel: { Args: { p_topic: string }; Returns: boolean }
      can_manage_branch: {
        Args: { _branch_id: string; _user_id: string }
        Returns: boolean
      }
      can_manage_project_financials: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      can_read_ai_conversation: {
        Args: { _conversation_id: string; _user_id: string }
        Returns: boolean
      }
      cancel_dock_appointment: {
        Args: { p_appointment_id: string; p_reason?: string }
        Returns: undefined
      }
      cancel_ownership_transfer: {
        Args: { p_transfer_id: string }
        Returns: undefined
      }
      cancel_scheduled_organization_deletion: {
        Args: { p_org_id: string }
        Returns: Json
      }
      canonicalise_salary_components: {
        Args: { p_structure_id: string }
        Returns: Json
      }
      canonicalize_role_key: { Args: { _key: string }; Returns: string }
      check_automation_circuit_breaker: {
        Args: {
          _automation_id: string
          _max_executions_per_hour?: number
          _organization_id: string
        }
        Returns: boolean
      }
      check_balance_integrity: {
        Args: { _business_id?: string; _org_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          business_id: string
          drift: number
          ledger_balance: number
          stored_balance: number
        }[]
      }
      check_budget_variance: {
        Args: {
          _account_ids: string[]
          _amounts: number[]
          _branch_id?: string
          _business_id: string
          _entry_date: string
          _org_id: string
        }
        Returns: Json
      }
      check_low_stock_products: { Args: never; Returns: undefined }
      check_org_app_access: {
        Args: { _app_id: string; _org_id: string }
        Returns: boolean
      }
      check_org_app_installed: {
        Args: { _app_id: string; _org_id: string }
        Returns: boolean
      }
      check_org_feature_access: {
        Args: { _feature_key: string; _org_id: string }
        Returns: boolean
      }
      check_org_feature_access_v2: {
        Args: { _feature_key: string; _org_id: string }
        Returns: boolean
      }
      check_org_subscription_active: {
        Args: { p_org_id: string }
        Returns: boolean
      }
      check_pack_install_allowed: {
        Args: { _acknowledge_skeleton?: boolean; _pack_id: string }
        Returns: Json
      }
      check_pin_exists: {
        Args: { p_device_fingerprint: string; p_user_id: string }
        Returns: Json
      }
      check_pin_status: { Args: { p_email: string }; Returns: Json }
      check_subscription_expired: {
        Args: { _org_id: string }
        Returns: boolean
      }
      check_user_invite_allowed: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      claim_next_business_event:
        | {
            Args: { p_limit?: number; p_org_id: string }
            Returns: {
              actor_user_id: string | null
              attempts: number
              branch_id: string | null
              claim_lease_seconds: number
              claimed_at: string | null
              completed_at: string | null
              created_at: string
              event_type: string
              handler_scope: string
              id: string
              idempotency_key: string
              last_error: string | null
              org_id: string
              payload: Json
              source: string
              source_doc_id: string
              source_doc_type: string
              status: Database["public"]["Enums"]["business_event_status"]
              updated_at: string
              warehouse_id: string | null
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "business_event_outbox"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: { p_claimant?: string; p_limit?: number; p_org_id: string }
            Returns: {
              actor_user_id: string | null
              attempts: number
              branch_id: string | null
              claim_lease_seconds: number
              claimed_at: string | null
              completed_at: string | null
              created_at: string
              event_type: string
              handler_scope: string
              id: string
              idempotency_key: string
              last_error: string | null
              org_id: string
              payload: Json
              source: string
              source_doc_id: string
              source_doc_type: string
              status: Database["public"]["Enums"]["business_event_status"]
              updated_at: string
              warehouse_id: string | null
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "business_event_outbox"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: {
              p_branch_id?: string
              p_claimant?: string
              p_limit?: number
              p_org_id: string
            }
            Returns: {
              actor_user_id: string | null
              attempts: number
              branch_id: string | null
              claim_lease_seconds: number
              claimed_at: string | null
              completed_at: string | null
              created_at: string
              event_type: string
              handler_scope: string
              id: string
              idempotency_key: string
              last_error: string | null
              org_id: string
              payload: Json
              source: string
              source_doc_id: string
              source_doc_type: string
              status: Database["public"]["Enums"]["business_event_status"]
              updated_at: string
              warehouse_id: string | null
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "business_event_outbox"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: {
              p_branch_id: string
              p_claimant: string
              p_handler_scope: string
              p_limit: number
              p_org_id: string
            }
            Returns: {
              actor_user_id: string | null
              attempts: number
              branch_id: string | null
              claim_lease_seconds: number
              claimed_at: string | null
              completed_at: string | null
              created_at: string
              event_type: string
              handler_scope: string
              id: string
              idempotency_key: string
              last_error: string | null
              org_id: string
              payload: Json
              source: string
              source_doc_id: string
              source_doc_type: string
              status: Database["public"]["Enums"]["business_event_status"]
              updated_at: string
              warehouse_id: string | null
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "business_event_outbox"
              isOneToOne: false
              isSetofReturn: true
            }
          }
      claim_print_jobs: {
        Args: { p_batch_size?: number }
        Returns: {
          acked_at: string | null
          artifact_id: string | null
          attempt_count: number
          branch_id: string | null
          business_id: string
          copies: number
          correlation_id: string
          created_at: string
          dedupe_key: string | null
          device_assignment_id: string | null
          disposition: Database["public"]["Enums"]["output_disposition"] | null
          doc_id: string | null
          doc_type: string
          document_record_id: string | null
          failed_at: string | null
          format: string
          hardware_role: string | null
          id: string
          intent: string
          last_error: string | null
          max_attempts: number
          media_profile_id: string | null
          medium: Database["public"]["Enums"]["output_medium"] | null
          next_attempt_at: string | null
          output_intent_id: string | null
          output_intent_target_id: string | null
          parent_job_id: string | null
          printer_profile_id: string | null
          processing_at: string | null
          render_params: Json
          requested_at: string
          requested_by: string | null
          requeued_count: number
          scenario: string
          sent_at: string | null
          status: Database["public"]["Enums"]["print_job_status"]
          transport: string
          triggered_source: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "print_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_scanner_session_pairing: {
        Args: { p_device_label: string; p_token: string }
        Returns: {
          branch_id: string
          business_id: string
          channel_key: string
          label: string
          organization_id: string
          session_id: string
          target_kind: string
        }[]
      }
      cleanup_automation_tracker: { Args: never; Returns: undefined }
      cleanup_orphan_signups: {
        Args: never
        Returns: {
          reaped_count: number
        }[]
      }
      cleanup_report_generation_logs: {
        Args: { _retention_days?: number }
        Returns: number
      }
      clear_admin_audit_log: {
        Args: { p_older_than_days?: number }
        Returns: number
      }
      clear_branch_setting: {
        Args: { p_branch_id: string; p_reason?: string; p_setting_key: string }
        Returns: Json
      }
      clear_settings_audit_log: {
        Args: { p_older_than_days?: number; p_org_id: string }
        Returns: number
      }
      close_department: {
        Args: { p_department_id: string }
        Returns: {
          actor_user_id: string | null
          business_id: string | null
          change_kind: Database["public"]["Enums"]["org_change_kind"]
          created_at: string
          entity_id: string
          entity_kind: Database["public"]["Enums"]["org_entity_kind"]
          id: string
          occurred_at: string
          organization_id: string
          payload: Json
          summary: string | null
        }
        SetofOptions: {
          from: "*"
          to: "org_change_log"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      close_fiscal_period: {
        Args: { _notes?: string; _period_id: string }
        Returns: {
          business_id: string
          closed_at: string | null
          closing_entry_id: string | null
          created_at: string
          end_date: string
          id: string
          is_closed: boolean
          locked_at: string | null
          locked_by: string | null
          name: string
          notes: string | null
          organization_id: string
          period_type: string | null
          start_date: string
          status: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "fiscal_periods"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      compensation_account: {
        Args: { _business_id: string; _key: string }
        Returns: string
      }
      complete_business_event: {
        Args: { p_error?: string; p_id: string; p_success: boolean }
        Returns: undefined
      }
      complete_customer_statement_send_job: {
        Args: { _error?: string; _job_id: string; _success: boolean }
        Returns: undefined
      }
      complete_dock_appointment: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      complete_onboarding: {
        Args: {
          p_business_type?: string
          p_company_name: string
          p_country: string
          p_currency: string
          p_founder_first_name?: string
          p_founder_last_name?: string
          p_idempotency_key?: string
          p_invitees?: Json
          p_legal_name?: string
          p_selected_app_ids?: string[]
          p_slug: string
        }
        Returns: Json
      }
      compute_employee_user_access_status: {
        Args: { p_employee_id: string }
        Returns: string
      }
      compute_project_profitability: {
        Args: { _project_id: string }
        Returns: Json
      }
      compute_remittance_due_date: {
        Args: {
          p_business_id: string
          p_country_code: string
          p_organization_id: string
          p_period_end: string
          p_rule_code: string
        }
        Returns: string
      }
      compute_unit_cost: {
        Args: {
          p_business_id: string
          p_product_id: string
          p_warehouse_id?: string
        }
        Returns: number
      }
      consolidation_diagnose_eliminations: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          business_a_currency: string
          business_a_id: string
          business_a_name: string
          business_b_currency: string
          business_b_id: string
          business_b_name: string
          cause: string
          difference_amount: number
          difference_signed: number
          effective_policy: string
          effective_tolerance: number
          elimination_class: Database["public"]["Enums"]["consolidation_elimination_class"]
          finding_kind: string
          is_cross_currency: boolean
          message: string
          presentation_currency: string
          remedies: string[]
          rule_exists: boolean
          suggested_tolerance: number
          would_refuse: boolean
        }[]
      }
      consolidation_effective_tolerance: {
        Args: {
          _business_a: string
          _business_b: string
          _class: Database["public"]["Enums"]["consolidation_elimination_class"]
          _gross_position: number
          _group_id: string
        }
        Returns: {
          difference_group_account_id: string
          difference_policy: string
          is_pair_override: boolean
          tolerance: number
          tolerance_amount: number
          tolerance_percent: number
          tolerance_reason: string
        }[]
      }
      consolidation_elimination_evidence: {
        Args: {
          _counterparty_business_id: string
          _date_from: string
          _date_to: string
          _declaring_business_id: string
          _elimination_class: Database["public"]["Enums"]["consolidation_elimination_class"]
          _group_account_id: string
          _group_id: string
        }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          basis: string
          counterparty_business_id: string
          counterparty_business_name: string
          credit_base: number
          credit_presentation: number
          debit_base: number
          debit_presentation: number
          declaring_business_id: string
          declaring_business_name: string
          entry_date: string
          entry_description: string
          entry_number: string
          group_account_code: string
          group_account_id: string
          group_account_name: string
          journal_entry_id: string
          presentation_currency: string
          rate_class: string
          rate_used: number
          viewer_can_open_ledger: boolean
        }[]
      }
      consolidation_eliminations_balance: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          elimination_class: Database["public"]["Enums"]["consolidation_elimination_class"]
          is_balanced: boolean
          out_of_balance: number
          total_credit: number
          total_debit: number
        }[]
      }
      consolidation_fx_remedy_note: {
        Args: { _as_of: string; _business_id: string }
        Returns: string
      }
      consolidation_generate_eliminations: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          difference_amount: number
          eliminated_credit: number
          eliminated_debit: number
          elimination_class: Database["public"]["Enums"]["consolidation_elimination_class"]
          line_count: number
          pair_count: number
        }[]
      }
      consolidation_group_uses_group_chart: {
        Args: { _group_id: string }
        Returns: boolean
      }
      consolidation_intercompany_entry_lines: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          basis: string
          counterparty_business_id: string
          counterparty_business_name: string
          credit_base: number
          credit_presentation: number
          debit_base: number
          debit_presentation: number
          declaring_business_id: string
          declaring_business_name: string
          entry_date: string
          entry_description: string
          entry_number: string
          group_account_code: string
          group_account_id: string
          group_account_name: string
          journal_entry_id: string
          presentation_currency: string
          rate_class: string
          rate_used: number
        }[]
      }
      consolidation_intercompany_flows: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          basis: string
          counterparty_business_id: string
          counterparty_business_name: string
          credit_base: number
          credit_presentation: number
          debit_base: number
          debit_presentation: number
          declaring_business_id: string
          declaring_business_name: string
          entry_count: number
          group_account_code: string
          group_account_id: string
          group_account_name: string
          presentation_currency: string
          rate_class: string
          rate_used: number
        }[]
      }
      consolidation_intercompany_scoped_entries: {
        Args: { _date_to: string; _group_id: string }
        Returns: {
          business_id: string
          counterparty_business_id: string
          description: string
          entry_date: string
          entry_number: string
          journal_entry_id: string
        }[]
      }
      consolidation_leg_faces_counterparty: {
        Args: {
          _account_id: string
          _business_id: string
          _contact_id: string
          _entry_date: string
          _group_id: string
        }
        Returns: boolean
      }
      consolidation_member_translation_rates: {
        Args: {
          _business_id: string
          _date_from: string
          _date_to: string
          _group_id: string
        }
        Returns: {
          average_rate: number
          closing_rate: number
          from_currency: string
          historical_date: string
          historical_rate: number
          opening_rate: number
          prior_average_rate: number
          to_currency: string
        }[]
      }
      consolidation_partner_integrity_report: {
        Args: { _group_id: string }
        Returns: {
          business_id: string
          business_name: string
          contact_id: string
          contact_is_company: boolean
          contact_name: string
          counterparty_business_id: string
          counterparty_business_name: string
          effective_from: string
          effective_to: string
          issue: string
          message: string
          partner_id: string
        }[]
      }
      consolidation_reverse_eliminations: {
        Args: {
          _date_from: string
          _date_to: string
          _group_id: string
          _reason: string
        }
        Returns: {
          reversed_leg_count: number
          reversed_total_credit: number
          reversed_total_debit: number
        }[]
      }
      consolidation_scope_member_count: {
        Args: { _as_of: string; _group_id: string }
        Returns: number
      }
      consolidation_seed_default_elimination_rules: {
        Args: { _group_id: string }
        Returns: number
      }
      consolidation_supersede_run: {
        Args: { _run_id: string; _superseded_by_run_id?: string }
        Returns: string
      }
      consolidation_tolerance_rounding_bound: {
        Args: { _currency: string }
        Returns: number
      }
      consolidation_translate_member: {
        Args: {
          _business_id: string
          _date_from: string
          _date_to: string
          _group_id: string
        }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          base_currency: string
          business_id: string
          business_name: string
          closing_balance: number
          is_nominal: boolean
          opening_balance: number
          presentation_currency: string
          rate_class: string
          rate_used: number
          total_credit: number
          total_debit: number
          translated_closing: number
          translated_credit: number
          translated_debit: number
          translated_opening: number
        }[]
      }
      consolidation_unmapped_accounts: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          business_id: string
          business_name: string
          closing_balance: number
        }[]
      }
      consume_so_reservation: {
        Args: {
          p_org_id: string
          p_product_id: string
          p_qty: number
          p_so_id: string
        }
        Returns: number
      }
      count_my_employee_drafts: {
        Args: { p_business_id: string; p_org_id: string }
        Returns: number
      }
      count_stale_employee_drafts: {
        Args: {
          p_business_id: string
          p_max_age_hours?: number
          p_organization_id: string
        }
        Returns: number
      }
      create_journal_entry_atomic: {
        Args: {
          _branch_id?: string
          _business_id: string
          _created_by: string
          _description: string
          _entry_date: string
          _entry_number: string
          _is_adjusting: boolean
          _is_closing: boolean
          _lines: Json
          _org_id: string
          _reference: string
        }
        Returns: string
      }
      create_notification: {
        Args: {
          p_business_id?: string
          p_category: string
          p_entity_id?: string
          p_entity_type?: string
          p_link?: string
          p_message: string
          p_organization_id: string
          p_priority?: number
          p_title: string
          p_type: string
          p_user_id: string
        }
        Returns: string
      }
      create_organization_with_owner:
        | {
            Args: { org_name: string; org_slug: string }
            Returns: {
              created_at: string
              created_by_platform_admin: boolean
              date_format: string | null
              default_payment_terms: number | null
              default_tax_rate_id: string | null
              deletion_cancelled_at: string | null
              deletion_grace_days: number | null
              deletion_reason: string | null
              deletion_requested_by: string | null
              deletion_scheduled_at: string | null
              deletion_status: string
              edge_allowed_origins: string[]
              external_customer_id: string | null
              external_subscription_id: string | null
              fiscal_year_start: number | null
              fiscalyear_lock_date: string | null
              governance_mode: string
              id: string
              is_suspended: boolean | null
              logo_url: string | null
              name: string
              number_format: string | null
              onboarding_idempotency_key: string | null
              owner_user_id: string | null
              period_lock_date: string | null
              scheduled_deletion_at: string | null
              setup_wizard_completed: boolean | null
              setup_wizard_step: number | null
              slug: string
              subscription_ends_at: string | null
              subscription_started_at: string | null
              subscription_status: string | null
              suspended_at: string | null
              suspended_reason: string | null
              tax_lock_date: string | null
              timezone: string | null
              trial_ends_at: string | null
              updated_at: string
            }
            SetofOptions: {
              from: "*"
              to: "organizations"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: {
              org_business_type?: string
              org_country?: string
              org_currency?: string
              org_is_multi_business?: boolean
              org_legal_name?: string
              org_name: string
              org_slug: string
            }
            Returns: {
              created_at: string
              created_by_platform_admin: boolean
              date_format: string | null
              default_payment_terms: number | null
              default_tax_rate_id: string | null
              deletion_cancelled_at: string | null
              deletion_grace_days: number | null
              deletion_reason: string | null
              deletion_requested_by: string | null
              deletion_scheduled_at: string | null
              deletion_status: string
              edge_allowed_origins: string[]
              external_customer_id: string | null
              external_subscription_id: string | null
              fiscal_year_start: number | null
              fiscalyear_lock_date: string | null
              governance_mode: string
              id: string
              is_suspended: boolean | null
              logo_url: string | null
              name: string
              number_format: string | null
              onboarding_idempotency_key: string | null
              owner_user_id: string | null
              period_lock_date: string | null
              scheduled_deletion_at: string | null
              setup_wizard_completed: boolean | null
              setup_wizard_step: number | null
              slug: string
              subscription_ends_at: string | null
              subscription_started_at: string | null
              subscription_status: string | null
              suspended_at: string | null
              suspended_reason: string | null
              tax_lock_date: string | null
              timezone: string | null
              trial_ends_at: string | null
              updated_at: string
            }
            SetofOptions: {
              from: "*"
              to: "organizations"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      create_scanner_session: {
        Args: {
          p_branch_id: string
          p_business_id: string
          p_label: string
          p_target_kind?: string
        }
        Returns: {
          expires_at: string
          id: string
          label: string
        }[]
      }
      create_scanner_session_pairing: {
        Args: { p_session_id: string }
        Returns: {
          expires_at: string
          session_id: string
          token: string
        }[]
      }
      crm_can_admin_pipeline: {
        Args: { _business_id: string; _org_id: string; _user_id: string }
        Returns: boolean
      }
      cron_caller_auth_header: { Args: never; Returns: Json }
      current_employee_id: {
        Args: { _organization_id: string }
        Returns: string
      }
      current_user_country_codes: { Args: never; Returns: string[] }
      customer_credit_account: {
        Args: { _business_id: string }
        Returns: string
      }
      customer_credit_balance_id: {
        Args: {
          _business_id: string
          _contact_id: string
          _currency: string
          _org_id: string
        }
        Returns: string
      }
      deactivate_collector_assignment: {
        Args: { _contact_id: string }
        Returns: undefined
      }
      default_journal_book_for_source: {
        Args: {
          _bank_account_id?: string
          _business_id: string
          _source_type: string
        }
        Returns: string
      }
      delete_ai_api_key: { Args: { p_id: string }; Returns: undefined }
      delete_all_chart_of_accounts: {
        Args: { p_organization_id: string }
        Returns: Json
      }
      delete_draft_journal_entry: {
        Args: { _entry_id: string }
        Returns: undefined
      }
      delete_integration_connection: {
        Args: { p_id: string }
        Returns: undefined
      }
      delete_journal_entry_atomic: {
        Args: { _je_id: string; _org_id: string }
        Returns: boolean
      }
      describe_exchange_rate: {
        Args: {
          p_business_id: string
          p_currency: string
          p_on_date: string
          p_org_id: string
        }
        Returns: {
          effective_date: string
          provider_key: string
          rate: number
          scope: string
          source: string
        }[]
      }
      diagnose_default_account_mappings: {
        Args: { _business_id: string; _org_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          detail: string
          issue_type: string
          setting_key: string
        }[]
      }
      disable_user_pin: { Args: never; Returns: Json }
      discard_employee_draft: {
        Args: { p_employee_id: string }
        Returns: boolean
      }
      discard_stale_employee_drafts: {
        Args: {
          p_business_id: string
          p_max_age_hours?: number
          p_organization_id: string
        }
        Returns: number
      }
      dissolve_department: {
        Args: { _department_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          branch_id: string | null
          business_id: string
          code: string | null
          created_at: string | null
          description: string | null
          dissolved_at: string | null
          dissolved_by: string | null
          id: string
          is_active: boolean | null
          manager_id: string | null
          name: string
          organization_id: string
          parent_department_id: string | null
          status: Database["public"]["Enums"]["department_status"]
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "departments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      document_artifacts_latest: {
        Args: {
          p_business_id: string
          p_document_id: string
          p_document_type: string
        }
        Returns: {
          branch_id: string | null
          business_id: string | null
          byte_size: number | null
          content_hash: string | null
          content_sha256: string | null
          copies: number | null
          created_at: string
          document_id: string | null
          document_number: string | null
          document_record_id: string | null
          document_type: string
          format: string | null
          id: string
          intent: string | null
          media_class: string | null
          metadata: Json
          mime_type: string | null
          organization_id: string
          page_count: number | null
          paper_format: string | null
          policy_id: string | null
          regeneration_reason: string | null
          render_mode: string | null
          rendered_by: string | null
          rendered_via: string | null
          retention_class: string
          storage_bucket: string
          storage_path: string
          superseded_by: string | null
          supersedes_id: string | null
          template_id: string | null
          template_version: number | null
          version: number
        }[]
        SetofOptions: {
          from: "*"
          to: "document_artifacts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      document_materialize_and_submit_intent: {
        Args: {
          p_branch_id?: string
          p_business_id?: string
          p_currency?: string
          p_document_date?: string
          p_document_number?: string
          p_kind_code: string
          p_locale?: string
          p_metadata?: Json
          p_organization_id: string
          p_party_id?: string
          p_party_kind?: string
          p_scenario?: string
          p_snapshot?: Json
          p_source_doc_id: string
          p_source_doc_type: string
          p_source_module: string
          p_triggered_source?: string
        }
        Returns: Json
      }
      earth: { Args: never; Returns: number }
      edge_jobs_expire_stale: { Args: never; Returns: number }
      email_outbox_recover_stuck: {
        Args: { p_older_than_minutes?: number }
        Returns: number
      }
      emit_business_event: {
        Args: {
          p_branch_id?: string
          p_business_id: string
          p_event_type: string
          p_idempotency_key: string
          p_org_id: string
          p_payload?: Json
          p_source_doc_id: string
          p_source_doc_type: string
          p_warehouse_id?: string
        }
        Returns: string
      }
      end_employee_branch_assignment: {
        Args: { p_assignment_id: string; p_effective_to?: string }
        Returns: undefined
      }
      enqueue_customer_statement_send: {
        Args: {
          _message?: string
          _recipient_email: string
          _statement_id: string
          _subject: string
        }
        Returns: string
      }
      enqueue_fiscal_receipt_required:
        | {
            Args: {
              p_branch_id: string
              p_business_id: string
              p_document_kind: string
              p_org_id: string
              p_payload: Json
              p_source_doc_id: string
              p_source_doc_type: string
            }
            Returns: string
          }
        | { Args: { p_transmission_id: string }; Returns: string }
      enqueue_sms_event: {
        Args: {
          p_business_id: string
          p_entity_id: string
          p_entity_type: string
          p_event_type: Database["public"]["Enums"]["sms_event_type"]
          p_organization_id: string
          p_recipient_contact_id?: string
          p_recipient_employee_id?: string
          p_recipient_phone?: string
          p_recipient_type?: string
          p_recipient_vendor_id?: string
          p_template_variables?: Json
        }
        Returns: string
      }
      ensure_cash_short_over_account: {
        Args: { p_business_id: string; p_org_id: string }
        Returns: string
      }
      ensure_company_contact: {
        Args: { p_business_id: string; p_name: string; p_org_id: string }
        Returns: string
      }
      ensure_default_account_mappings: {
        Args: { _business_id: string; _org_id: string }
        Returns: {
          account_id: string
          role_key: string
          status: string
        }[]
      }
      ensure_default_branch_for_business: {
        Args: { p_business_id: string; p_org_id: string }
        Returns: string
      }
      ensure_default_email_templates: {
        Args: { _org_id: string }
        Returns: undefined
      }
      ensure_default_legal_order_workflow: {
        Args: { p_organization_id: string }
        Returns: string
      }
      ensure_default_scrap_reasons: {
        Args: { p_org_id: string }
        Returns: undefined
      }
      ensure_document_record:
        | {
            Args: {
              p_branch_id?: string
              p_business_id?: string
              p_currency?: string
              p_kind_code: string
              p_locale?: string
              p_metadata?: Json
              p_organization_id: string
              p_party_id?: string
              p_party_kind?: string
              p_source_doc_id: string
              p_source_doc_type: string
              p_source_module: string
            }
            Returns: string
          }
        | {
            Args: {
              p_branch_id?: string
              p_business_id?: string
              p_currency?: string
              p_document_date?: string
              p_document_number?: string
              p_kind_code: string
              p_locale?: string
              p_metadata?: Json
              p_organization_id: string
              p_party_id?: string
              p_party_kind?: string
              p_snapshot?: Json
              p_source_doc_id: string
              p_source_doc_type: string
              p_source_module: string
            }
            Returns: string
          }
      ensure_loan_gl_accounts: {
        Args: { _biz: string; _org: string }
        Returns: Json
      }
      ensure_opening_balance_equity_account: {
        Args: { _business_id: string; _org_id: string }
        Returns: string
      }
      evaluate_promise_status: {
        Args: { _business_id?: string }
        Returns: number
      }
      execute_due_scheduled_organization_deletions: {
        Args: never
        Returns: Json
      }
      expense_approve: { Args: { p_expense_id: string }; Returns: Json }
      expense_is_own_or_report: {
        Args: { _created_by: string; _employee_id: string; _user_id: string }
        Returns: boolean
      }
      expense_reimburse_direct: {
        Args: {
          p_bank_account_id: string
          p_expense_id: string
          p_payment_date?: string
          p_reference?: string
        }
        Returns: Json
      }
      expense_reject: {
        Args: { p_expense_id: string; p_reason?: string }
        Returns: Json
      }
      expense_submit: { Args: { p_expense_id: string }; Returns: Json }
      expense_void:
        | { Args: { p_expense_id: string; p_reason?: string }; Returns: Json }
        | {
            Args: {
              p_expense_id: string
              p_reason?: string
              p_reason_code?: string
            }
            Returns: Json
          }
      fetch_collector_assignments_with_names: {
        Args: { _org_id: string }
        Returns: {
          active: boolean
          assigned_at: string
          collector_email: string
          collector_name: string
          collector_user_id: string
          contact_id: string
          id: string
        }[]
      }
      fetch_org_members: {
        Args: { _org_id: string }
        Returns: {
          email: string
          full_name: string
          user_id: string
        }[]
      }
      finalize_table_order: {
        Args: {
          p_created_by?: string
          p_payments: Json
          p_tip_amount?: number
          p_transaction_id: string
        }
        Returns: Json
      }
      finance_aging_bucket: {
        Args: { p_as_of: string; p_due_date: string }
        Returns: string
      }
      finance_ar_customer_credit_as_of: {
        Args: {
          _as_of?: string
          _branch_id?: string
          _business_id?: string
          _org_id: string
        }
        Returns: {
          base_credit_amount: number
          branch_id: string
          business_id: string
          contact_id: string
          credit_amount: number
          currency: string
          organization_id: string
        }[]
      }
      finance_ar_open_items_as_of: {
        Args: {
          _as_of?: string
          _branch_id?: string
          _business_id?: string
          _org_id: string
        }
        Returns: {
          aging_bucket: string
          base_residual_amount: number
          branch_id: string
          business_id: string
          contact_id: string
          credited_amount: number
          currency: string
          days_past_due: number
          document_date: string
          document_id: string
          document_number: string
          document_status: string
          document_total: number
          due_date: string
          exchange_rate: number
          journal_entry_id: string
          organization_id: string
          paid_amount: number
          residual_amount: number
          source_kind: string
        }[]
      }
      finance_bank_reconciliation_statement: {
        Args: {
          _as_of: string
          _bank_account_id: string
          _branch_id?: string
          _business_id?: string
          _org_id: string
        }
        Returns: Json
      }
      finance_can_read_branch: {
        Args: { _branch_id: string; _business_id: string; _org_id: string }
        Returns: boolean
      }
      finance_can_read_financials: {
        Args: { _business_id: string; _org_id: string }
        Returns: boolean
      }
      finance_can_read_org: { Args: { _org_id: string }; Returns: boolean }
      finance_can_read_scope: {
        Args: { _business_id?: string; _org_id: string }
        Returns: boolean
      }
      finance_cash_flow_statement: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _from: string
          _org_id: string
          _to: string
        }
        Returns: Json
      }
      finance_partner_ledger: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _contact_id?: string
          _from?: string
          _limit?: number
          _offset?: number
          _org_id: string
          _search?: string
          _side?: string
          _to?: string
        }
        Returns: Json
      }
      finance_partner_ledger_reconciliation: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _org_id: string
          _side?: string
          _to?: string
        }
        Returns: {
          control_account_balance: number
          in_balance: boolean
          ledger_total: number
          variance: number
        }[]
      }
      finance_post_gr_journal: {
        Args: { _actor: string; _gr_id: string }
        Returns: Json
      }
      find_cross_business_journal_lines: {
        Args: never
        Returns: {
          account_business_id: string
          account_id: string
          entry_business_id: string
          entry_id: string
          line_id: string
        }[]
      }
      fiscal_transmission_resend: {
        Args: { p_transmission_id: string }
        Returns: boolean
      }
      fx_exposure_by_currency: {
        Args: { _as_of?: string; _business_id: string }
        Returns: Json
      }
      fx_exposure_dimensions: {
        Args: { _as_of?: string; _business_id: string; _currency?: string }
        Returns: Json
      }
      fx_exposure_open_items: {
        Args: { _as_of?: string; _business_id: string; _currency: string }
        Returns: Json
      }
      fx_is_monetary_account: {
        Args: { _account_type: string; _detail_type: string }
        Returns: boolean
      }
      fx_open_monetary_positions: {
        Args: { _as_of: string; _business_id: string }
        Returns: {
          account_id: string
          base_balance_old: number
          contact_id: string
          currency: string
          foreign_balance: number
        }[]
      }
      fx_period_average_rate: {
        Args: {
          _business_id: string
          _date_from: string
          _date_to: string
          _from_currency: string
          _org_id: string
          _to_currency: string
        }
        Returns: number
      }
      fx_rate_on: {
        Args: {
          _business_id: string
          _from_currency: string
          _on_date: string
          _org_id: string
          _to_currency: string
        }
        Returns: number
      }
      fx_realized_gain_loss: {
        Args: { _business_id: string; _from?: string; _to?: string }
        Returns: Json
      }
      fx_report_document_rate: {
        Args: {
          p_base_currency: string
          p_document_currency: string
          p_stamped_rate: number
        }
        Returns: number
      }
      fx_revaluation_readiness: {
        Args: { _as_of: string; _business_id: string }
        Returns: Json
      }
      fx_stamp_document: {
        Args: {
          p_biz: string
          p_currency: string
          p_date: string
          p_org: string
        }
        Returns: Record<string, unknown>
      }
      fx_unrecognised_exchange_difference: {
        Args: { _as_of: string; _business_id: string }
        Returns: {
          carried_rate: number
          closing_rate: number
          currency: string
          foreign_balance: number
          unrecognised: number
        }[]
      }
      garnishment_apply_pack_to_org: {
        Args: { p_org_id: string; p_pack_id: string }
        Returns: number
      }
      garnishment_recipient_contact_for_order: {
        Args: { p_order_id: string }
        Returns: string
      }
      garnishment_resolve_kinds: {
        Args: { p_org_id: string }
        Returns: {
          aggregate_cap_membership: Database["public"]["Enums"]["legal_order_cap_membership"]
          always_first: boolean
          calc_model: Database["public"]["Enums"]["legal_order_calc_model"]
          counts_toward_aggregate_cap: boolean
          default_priority: number
          employer_fee_amount: number
          evidence_required: boolean
          kind: string
          label: string
          max_concurrent: number
          priority_class: number
          protected_earnings_rule: Json
          required_identifiers: Json
          source: string
          source_pack_id: string
        }[]
      }
      garnishment_resolve_policy: { Args: { p_org_id: string }; Returns: Json }
      gc_pack_readiness_rules: { Args: { _org_id: string }; Returns: number }
      generate_loan_schedule: {
        Args: { _dry_run?: boolean; _loan_id: string }
        Returns: Json
      }
      generate_next_je_number: {
        Args: { _business_id?: string; _org_id: string }
        Returns: string
      }
      get_account_balance_at_date: {
        Args: { p_account_id: string; p_as_of_date: string }
        Returns: number
      }
      get_account_balances: {
        Args: { _branch_id?: string; _business_id: string; _org_id: string }
        Returns: {
          account_id: string
          net_balance: number
          total_credit: number
          total_debit: number
        }[]
      }
      get_account_movements:
        | {
            Args: { _date_from?: string; _date_to?: string; _org_id: string }
            Returns: {
              account_id: string
              total_credit: number
              total_debit: number
            }[]
          }
        | {
            Args: {
              _business_id?: string
              _date_from: string
              _date_to: string
              _org_id: string
            }
            Returns: {
              account_id: string
              total_credit: number
              total_debit: number
            }[]
          }
        | {
            Args: {
              _branch_id?: string
              _business_id?: string
              _date_from: string
              _date_to: string
              _org_id: string
            }
            Returns: {
              account_id: string
              total_credit: number
              total_debit: number
            }[]
          }
      get_ai_api_key_secret: { Args: { p_id: string }; Returns: string }
      get_all_subordinates: {
        Args: { _manager_employee_id: string }
        Returns: string[]
      }
      get_ar_ap_aging_from_ledger: {
        Args: {
          _as_of_date: string
          _branch_id?: string
          _business_id: string
          _org_id: string
          _report_type: string
        }
        Returns: {
          applied_amount: number
          bucket: string
          company: string
          contact_id: string
          contact_name: string
          days_overdue: number
          document_date: string
          document_id: string
          document_number: string
          document_total: number
          due_date: string
          email: string
          journal_entry_id: string
          residual_amount: number
        }[]
      }
      get_bank_transactions_paginated: {
        Args: {
          _bank_account_id?: string
          _branch_id?: string
          _business_id?: string
          _end_date?: string
          _is_reconciled?: boolean
          _org_id: string
          _page_offset?: number
          _page_size?: number
          _search_query?: string
          _start_date?: string
          _transaction_type?: string
        }
        Returns: {
          ai_confidence: number
          ai_reasoning: string
          ai_suggested_category: string
          amount: number
          balance_after: number
          bank_account_id: string
          bank_account_name: string
          bank_name: string
          category: string
          category_confidence: number
          created_at: string
          description: string
          external_transaction_id: string
          id: string
          is_reconciled: boolean
          journal_entry_id: string
          organization_id: string
          posting_date: string
          raw_data: Json
          reconciled_at: string
          reconciled_by: string
          reconciled_entity_id: string
          reconciled_payment_id: string
          reconciled_type: string
          reference: string
          total_count: number
          transaction_date: string
          transaction_type: string
          updated_at: string
        }[]
      }
      get_budget_variance_report: {
        Args: { _budget_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: string
          actual_amount: number
          budgeted_amount: number
          fiscal_period_id: string
          is_favourable: boolean
          is_unbudgeted: boolean
          period_end: string
          period_month: number
          period_ordinal: number
          period_start: string
          period_status: string
          variance_amount: number
          variance_percent: number
        }[]
      }
      get_commercial_timeline: {
        Args: { _before?: string; _limit?: number; _org_id: string }
        Returns: {
          actor_email: string
          actor_id: string
          app_id: string
          created_at: string
          event_type: string
          id: string
          payload: Json
          plan_id: string
        }[]
      }
      get_consolidated_statement_lines: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          amount: number
          is_derived: boolean
          is_residual: boolean
          presentation_currency: string
          section: string
          section_order: number
          statement: string
        }[]
      }
      get_consolidated_statement_lines_eliminated: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          aggregated_amount: number
          consolidated_amount: number
          elimination_amount: number
          is_derived: boolean
          is_residual: boolean
          presentation_currency: string
          reconciling_amount: number
          section: string
          section_order: number
          statement: string
        }[]
      }
      get_consolidated_statement_totals: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          balance_difference: number
          is_balanced: boolean
          net_result: number
          presentation_currency: string
          total_assets: number
          total_equity: number
          total_expense: number
          total_income: number
          total_liabilities: number
          translation_reserve: number
        }[]
      }
      get_consolidated_statement_totals_eliminated: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          balance_sheet_difference: number
          eliminations_credit: number
          eliminations_debit: number
          is_balanced: boolean
          net_result: number
          presentation_currency: string
          total_assets: number
          total_equity: number
          total_expense: number
          total_income: number
          total_liabilities: number
          translation_reserve: number
        }[]
      }
      get_consolidated_trial_balance_translated: {
        Args: { _date_from: string; _date_to: string; _group_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          base_currency: string
          business_id: string
          business_name: string
          closing_balance: number
          group_account_code: string
          group_account_id: string
          group_account_name: string
          is_mapped: boolean
          is_nominal: boolean
          is_parent: boolean
          opening_balance: number
          ownership_percent: number
          presentation_currency: string
          rate_class: string
          rate_used: number
          total_credit: number
          total_debit: number
          translated_closing: number
          translated_credit: number
          translated_debit: number
          translated_opening: number
        }[]
      }
      get_control_account_reconciliation: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _org_id: string
          _report_type?: string
        }
        Returns: {
          control_account_id: string
          drift: number
          gl_closing: number
          has_drift: boolean
          has_migration_je: boolean
          opening_balance: number
          sub_ledger_total: number
        }[]
      }
      get_current_employee: {
        Args: { _organization_id?: string }
        Returns: string
      }
      get_dashboard_activity: {
        Args: {
          _branch_id: string
          _business_id: string
          _kind: string
          _limit?: number
        }
        Returns: Json
      }
      get_dashboard_stats: {
        Args: {
          _branch_id: string
          _business_id: string
          _from: string
          _kind: string
          _monthly_from: string
          _to: string
        }
        Returns: Json
      }
      get_default_account_id: {
        Args: { _business_id: string; _org_id: string; _setting_key: string }
        Returns: string
      }
      get_default_branch_id: { Args: { _business_id: string }; Returns: string }
      get_default_business_id: { Args: { _org_id: string }; Returns: string }
      get_direct_reports: {
        Args: { _manager_employee_id: string }
        Returns: string[]
      }
      get_effective_company_config: {
        Args: { p_branch_id?: string; p_business_id: string }
        Returns: Json
      }
      get_effective_user_limit: { Args: { _org_id: string }; Returns: number }
      get_email_provider_settings: { Args: never; Returns: Json }
      get_employee_directory_stats: {
        Args: {
          p_branch_ids?: string[]
          p_business_id: string
          p_org_id: string
        }
        Returns: Json
      }
      get_employee_hours_in_period: {
        Args: {
          p_employee_id: string
          p_end_date: string
          p_start_date: string
        }
        Returns: number
      }
      get_employee_pii: { Args: { p_employee_id: string }; Returns: Json }
      get_equity_result: {
        Args: {
          _as_of: string
          _branch_id?: string
          _business_id: string
          _org_id: string
        }
        Returns: {
          current_year_earnings: number
          fiscal_year_start: string
          prior_years_result: number
          retained_earnings_account_id: string
        }[]
      }
      get_executive_stats: {
        Args: { _branch_id: string; _business_id: string; _kind: string }
        Returns: Json
      }
      get_finance_readiness: { Args: { _business_id: string }; Returns: Json }
      get_general_ledger: {
        Args: {
          _account_ids?: string[]
          _branch_id?: string
          _business_id?: string
          _date_from: string
          _date_to: string
          _include_zero_activity?: boolean
          _org_id: string
        }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: string
          branch_name: string
          contact_name: string
          credit: number
          debit: number
          entry_currency: string
          entry_date: string
          entry_number: string
          entry_status: string
          exchange_rate: number
          is_reversal: boolean
          je_description: string
          journal_book: string
          journal_entry_id: string
          line_description: string
          line_id: string
          opening_balance: number
          original_credit: number
          original_debit: number
          reference: string
          reversal_of_number: string
          source_id: string
          source_type: string
        }[]
      }
      get_gl_pnl_totals: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _date_from: string
          _date_to: string
          _org_id: string
        }
        Returns: {
          expenses: number
          net_profit: number
          revenue: number
        }[]
      }
      get_gl_transactions:
        | {
            Args: {
              _account_ids?: string[]
              _date_from: string
              _date_to: string
              _org_id: string
            }
            Returns: {
              account_id: string
              contact_name: string
              credit: number
              debit: number
              entry_date: string
              entry_description: string
              entry_id: string
              entry_number: string
              line_description: string
              line_id: string
              reference: string
              source_id: string
              source_type: string
            }[]
          }
        | {
            Args: {
              _account_ids: string[]
              _branch_id?: string
              _date_from: string
              _date_to: string
              _org_id: string
            }
            Returns: {
              account_id: string
              branch_id: string
              credit: number
              debit: number
              description: string
              entry_date: string
              entry_id: string
              entry_number: string
              reference: string
            }[]
          }
      get_journal_report: {
        Args: {
          _branch_id?: string
          _business_id?: string
          _date_from: string
          _date_to: string
          _limit?: number
          _offset?: number
          _org_id: string
          _source_types?: string[]
        }
        Returns: {
          account_code: string
          account_name: string
          branch_name: string
          credit: number
          debit: number
          entry_currency: string
          entry_date: string
          entry_id: string
          entry_number: string
          entry_status: string
          exchange_rate: number
          is_reversal: boolean
          je_description: string
          journal_book: string
          line_description: string
          line_id: string
          original_credit: number
          original_debit: number
          reference: string
          reversal_of_number: string
          source_id: string
          source_type: string
          total_entries: number
        }[]
      }
      get_ledger_opening_balances: {
        Args: {
          _as_of: string
          _branch_id?: string
          _business_id: string
          _org_id: string
        }
        Returns: {
          account_id: string
          fiscal_year_start: string
          is_nominal: boolean
          opening_balance: number
        }[]
      }
      get_linkable_users_for_employee: {
        Args: { p_employee_id: string; p_org_id: string }
        Returns: {
          block_reason: string
          display_name: string
          email_masked: string
          linkability: string
          user_id: string
        }[]
      }
      get_next_asset_number: { Args: { _org_id: string }; Returns: string }
      get_next_contract_reference: {
        Args: { p_org_id: string }
        Returns: string
      }
      get_next_delivery_number: { Args: { _org_id: string }; Returns: string }
      get_next_document_number: {
        Args: {
          p_business: string
          p_business_column?: string
          p_column: string
          p_org: string
          p_prefix: string
          p_table: string
          p_width?: number
        }
        Returns: string
      }
      get_next_employee_number: {
        Args: { _business_id?: string; _org_id: string }
        Returns: string
      }
      get_next_expense_number: {
        Args: { _branch_id?: string; _business_id?: string; _org_id: string }
        Returns: string
      }
      get_next_journal_entry_number: {
        Args: { _org_id: string }
        Returns: string
      }
      get_next_recall_reference: {
        Args: { p_business?: string; p_org: string }
        Returns: string
      }
      get_next_receipt_number: {
        Args: { _branch_id?: string; _business_id?: string; _org_id: string }
        Returns: string
      }
      get_next_so_number: { Args: { _org_id: string }; Returns: string }
      get_or_create_default_business_for_org: {
        Args: { _org_id: string }
        Returns: string
      }
      get_org_feature_limit: {
        Args: { _feature_key: string; _org_id: string }
        Returns: number
      }
      get_org_storage_breakdown: {
        Args: { p_organization_id: string }
        Returns: {
          bucket_name: string
          file_count: number
          total_bytes: number
          total_mb: number
        }[]
      }
      get_org_storage_usage_mb: {
        Args: { p_organization_id: string }
        Returns: number
      }
      get_org_usage_counters: { Args: { _org_id: string }; Returns: Json }
      get_organization_deletion_jobs: {
        Args: { _org_id?: string }
        Returns: {
          attempts: number
          created_at: string
          error_text: string | null
          finished_at: string | null
          id: string
          kind: string
          organization_id: string
          organization_name: string | null
          requested_by: string | null
          result: Json | null
          scheduled_for: string | null
          started_at: string | null
          status: string
          storage_cleanup_pending: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "organization_deletion_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_period_budget_variance: {
        Args: { _fiscal_period_id: string }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
          account_type: string
          actual_amount: number
          budget_id: string
          budgeted_amount: number
          is_favourable: boolean
          is_unbudgeted: boolean
          variance_amount: number
          variance_percent: number
        }[]
      }
      get_platform_admin_permissions: {
        Args: { _user_id: string }
        Returns: string[]
      }
      get_platform_admin_role: { Args: { _user_id: string }; Returns: string }
      get_platform_admin_scopes: {
        Args: { _user_id: string }
        Returns: string[]
      }
      get_sms_config_masked: {
        Args: { p_organization_id: string }
        Returns: {
          account_sid_masked: string
          auth_token_masked: string
          business_id: string
          created_at: string
          created_by: string
          daily_limit: number
          id: string
          is_enabled: boolean
          last_reset_date: string
          last_test_at: string
          last_test_error: string
          last_test_status: string
          messages_sent_today: number
          messaging_service_sid: string
          organization_id: string
          provider: string
          provider_mode: string
          sender_phone: string
          updated_at: string
          webhook_url: string
        }[]
      }
      get_subscription_days_remaining: {
        Args: { _org_id: string }
        Returns: number
      }
      get_timesheet_employee_metrics: {
        Args: {
          p_business_id: string
          p_from: string
          p_organization_id: string
          p_to: string
        }
        Returns: {
          approved_hours: number
          billable_hours: number
          employee_id: string
          employee_name: string
          employee_number: string
          non_billable_hours: number
          overtime_hours: number
          payroll_locked_hours: number
          total_hours: number
          uninvoiced_billable_hours: number
          utilization_pct: number
        }[]
      }
      get_timesheet_project_metrics: {
        Args: {
          p_business_id: string
          p_from: string
          p_organization_id: string
          p_to: string
        }
        Returns: {
          approved_hours: number
          billable_hours: number
          customer_id: string
          invoiced_hours: number
          non_billable_hours: number
          project_id: string
          project_is_billable: boolean
          project_name: string
          project_number: string
          total_hours: number
          uninvoiced_billable_hours: number
          utilization_pct: number
        }[]
      }
      get_timesheet_summary: {
        Args: {
          p_business_id: string
          p_from: string
          p_organization_id: string
          p_to: string
        }
        Returns: {
          approved_hours: number
          billable_hours: number
          employee_count: number
          non_billable_hours: number
          overtime_hours: number
          payroll_locked_hours: number
          total_hours: number
          uninvoiced_billable_hours: number
          utilization_pct: number
        }[]
      }
      get_timesheet_uninvoiced_billable: {
        Args: {
          p_business_id: string
          p_from: string
          p_organization_id: string
          p_to: string
        }
        Returns: {
          billing_amount: number
          date: string
          employee_id: string
          employee_name: string
          hours: number
          project_id: string
          project_name: string
          timesheet_id: string
        }[]
      }
      get_user_allowed_branches: {
        Args: { _business_id: string; _user_id: string }
        Returns: {
          business_id: string
          can_manage: boolean
          code: string
          id: string
          is_active: boolean
          is_headquarters: boolean
          is_primary_assignment: boolean
          name: string
          organization_id: string
        }[]
      }
      get_user_allowed_businesses: {
        Args: { _org_id: string; _user_id: string }
        Returns: string[]
      }
      get_user_default_branch: {
        Args: { _business_id: string; _user_id: string }
        Returns: string
      }
      get_user_org_role: {
        Args: { _organization_id: string; _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      get_user_organization_ids: { Args: never; Returns: string[] }
      get_user_organizations: { Args: { _user_id: string }; Returns: string[] }
      get_user_primary_branch: {
        Args: { _business_id: string; _user_id: string }
        Returns: string
      }
      get_user_session_data: { Args: { p_user_id: string }; Returns: Json }
      get_user_type: {
        Args: { _org_id: string; _user_id: string }
        Returns: string
      }
      get_vendor_contact_id: { Args: { _user_id: string }; Returns: string }
      governance_assert_not_self: {
        Args: {
          p_action: string
          p_actor: string
          p_entity_id?: string
          p_entity_type?: string
          p_org?: string
          p_subject: string
        }
        Returns: undefined
      }
      governance_assert_not_subject: {
        Args: {
          p_action: string
          p_actor: string
          p_employee_id: string
          p_entity_id?: string
          p_entity_type?: string
          p_org?: string
        }
        Returns: undefined
      }
      governance_list_modules: {
        Args: never
        Returns: {
          depends_on: string[]
          derived_projections: string[]
          description: string | null
          display_name: string
          export_fn: string | null
          is_active: boolean
          module_key: string
          owns_sequences: string[]
          owns_storage_prefixes: Json
          owns_tables: string[]
          preview_fn: string | null
          registered_at: string
          teardown_fn: string | null
          updated_at: string
          version: number
        }[]
        SetofOptions: {
          from: "*"
          to: "governance_modules"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      governance_list_unowned_tables: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      governance_run_teardown: {
        Args: {
          p_backup_first?: boolean
          p_confirmation: string
          p_modules: string[]
          p_org_id: string
        }
        Returns: Json
      }
      governance_self_action_verdict: {
        Args: {
          p_action: string
          p_actor: string
          p_entity_id?: string
          p_org: string
          p_subject: string
        }
        Returns: string
      }
      governance_sod_violations: {
        Args: { _org_id: string }
        Returns: {
          duty_a: string
          duty_b: string
          rationale: string
          severity: string
          user_email: string
          user_id: string
          user_name: string
        }[]
      }
      governance_user_duties: {
        Args: { _org_id: string; _user_id: string }
        Returns: {
          duty_code: string
        }[]
      }
      gs1_ai_table: {
        Args: never
        Returns: {
          ai: string
          decimal_indicator: boolean
          fixed: number
          max_len: number
          name: string
        }[]
      }
      gs1_check_digit: { Args: { p_body: string }; Returns: number }
      has_any_org_role: {
        Args: {
          _organization_id: string
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_app_entitlement: {
        Args: { _app_id: string; _org_id: string }
        Returns: boolean
      }
      has_dashboard_permission: {
        Args: { _business_id?: string; _perm: string; _user_id: string }
        Returns: boolean
      }
      has_dashboard_permissions: {
        Args: { _business_id: string; _perms: string[]; _user_id: string }
        Returns: Json
      }
      has_finance_permission: {
        Args: { _business_id?: string; _perm: string; _user_id: string }
        Returns: boolean
      }
      has_org_role: {
        Args: {
          _organization_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_payroll_access: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      has_platform_permission: {
        Args: { _permission: string; _user_id: string }
        Returns: boolean
      }
      has_role:
        | {
            Args: {
              _organization_id: string
              _role: Database["public"]["Enums"]["app_role"]
              _user_id: string
            }
            Returns: boolean
          }
        | { Args: { _role: string; _user_id: string }; Returns: boolean }
      has_user_pin:
        | { Args: never; Returns: boolean }
        | { Args: { p_device_fingerprint?: string }; Returns: boolean }
      hr_list_failed_onboarding_attempts: {
        Args: { p_limit?: number; p_org_id: string }
        Returns: {
          company_name: string
          completed_at: string
          diagnostics: Json
          error_message: string
          id: string
          started_at: string
          status: string
          updated_at: string
          user_id: string
        }[]
      }
      hr_notify_approval_event: {
        Args: {
          _actor?: string
          _entity_id: string
          _entity_type: string
          _event: string
        }
        Returns: Json
      }
      identity_code_candidates: { Args: { p_raw: string }; Returns: string[] }
      install_app: {
        Args: { p_app_id: string; p_org_id: string }
        Returns: {
          app_id: string
          created_at: string
          id: string
          installed_at: string
          installed_by: string | null
          is_active: boolean
          last_accessed_at: string | null
          lifecycle_state: Database["public"]["Enums"]["app_lifecycle_state"]
          onboarding_status: string
          organization_id: string
          settings: Json
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "organization_installed_apps"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      install_localization_pack_atomic: {
        Args: {
          _business_id: string
          _force_reseed?: boolean
          _installed_by: string
          _pack_id: string
        }
        Returns: Json
      }
      is_ap_control_account: { Args: { _account_id: string }; Returns: boolean }
      is_ar_control_account: { Args: { _account_id: string }; Returns: boolean }
      is_finance_manager: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_governance_authority: {
        Args: { _organization_id: string; _user_id: string }
        Returns: boolean
      }
      is_hr_user: { Args: { _organization_id: string }; Returns: boolean }
      is_manager_of:
        | { Args: { _employee_id: string }; Returns: boolean }
        | {
            Args: { _employee_id: string; _manager_user_id: string }
            Returns: boolean
          }
      is_org_admin: {
        Args: { _organization_id: string; _user_id: string }
        Returns: boolean
      }
      is_org_admin_or_owner: {
        Args: { _organization_id: string; _user_id: string }
        Returns: boolean
      }
      is_org_administrator: {
        Args: { _org_id: string; _user_id: string }
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
      is_org_subscription_active: {
        Args: { _org_id: string }
        Returns: boolean
      }
      is_pack_publisher: {
        Args: { _pack_id: string; _user_id: string }
        Returns: boolean
      }
      is_period_locked: {
        Args: {
          p_business_id: string
          p_date: string
          p_organization_id: string
        }
        Returns: boolean
      }
      is_period_open: {
        Args: { _business_id: string; _post_date: string }
        Returns: boolean
      }
      is_platform_admin: { Args: { _user_id: string }; Returns: boolean }
      is_project_member: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      is_subscription_active: { Args: { _org_id: string }; Returns: boolean }
      is_talent_admin: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_vendor_portal_user: { Args: { _user_id: string }; Returns: boolean }
      landed_cost_assert_bill_unencumbered: {
        Args: { _bill_id: string; _operation?: string }
        Returns: undefined
      }
      landed_cost_assert_receipt_unencumbered: {
        Args: { _goods_receipt_id: string; _operation?: string }
        Returns: undefined
      }
      landed_cost_bill_block_reason: {
        Args: { _bill_id: string }
        Returns: string
      }
      landed_cost_bill_encumbrance: {
        Args: { _bill_id: string }
        Returns: Json
      }
      landed_cost_receipt_block_reason: {
        Args: { _goods_receipt_id: string }
        Returns: string
      }
      landed_cost_receipt_encumbrance: {
        Args: { _goods_receipt_id: string }
        Returns: Json
      }
      landed_cost_receipt_summary: {
        Args: { p_receipt_ids: string[] }
        Returns: {
          allocated_amount: number
          capitalized_amount: number
          currency: string
          expensed_amount: number
          goods_receipt_id: string
          pending_count: number
          posted_count: number
          voucher_count: number
        }[]
      }
      landed_cost_valuation_attribution: {
        Args: { p_business_id: string; p_product_ids?: string[] }
        Returns: {
          last_applied_at: string
          last_voucher_id: string
          product_id: string
          revaluation_count: number
          unit_cost_after: number
          unit_cost_before: number
          uplift_amount: number
        }[]
      }
      landed_cost_workspace_summary: {
        Args: { p_business_id: string }
        Returns: Json
      }
      ledger_visible_journal_statuses: {
        Args: never
        Returns: Database["public"]["Enums"]["journal_status"][]
      }
      legal_orders_return_extract: {
        Args: {
          _branch_id?: string
          _business_id: string
          _organization_id: string
          _period_end: string
          _period_start: string
        }
        Returns: {
          authority_code: string
          authority_id: string
          authority_name: string
          calc_model: string
          case_reference: string
          employee_id: string
          end_date: string
          gross_deducted: number
          kind_code: string
          line_count: number
          order_id: string
          period_end: string
          period_start: string
          priority_class: number
          start_date: string
        }[]
      }
      legal_recipient_statement: {
        Args: { p_from: string; p_recipient_id: string; p_to: string }
        Returns: {
          amount: number
          employee_id: string
          entry_date: string
          entry_kind: string
          garnishment_id: string
          payment_id: string
          payroll_run_id: string
          reference: string
        }[]
      }
      link_self_as_employee: { Args: never; Returns: string }
      list_business_active_currencies: {
        Args: { _business_id: string }
        Returns: {
          currency_code: string
          is_base: boolean
          is_enabled: boolean
        }[]
      }
      list_employee_ids_matching: {
        Args: {
          p_branch_ids?: string[]
          p_business_id: string
          p_department_id?: string
          p_health?: string
          p_location_id?: string
          p_mine_only?: boolean
          p_org_id: string
          p_position_id?: string
          p_search?: string
          p_status?: string
        }
        Returns: string[]
      }
      list_employees_paged: {
        Args: {
          p_branch_ids?: string[]
          p_business_id: string
          p_cursor_created_at?: string
          p_cursor_id?: string
          p_department_id?: string
          p_health?: string
          p_location_id?: string
          p_mine_only?: boolean
          p_org_id: string
          p_page_size?: number
          p_position_id?: string
          p_search?: string
          p_status?: string
        }
        Returns: Json[]
      }
      list_org_storage_paths: { Args: { org_id: string }; Returns: Json }
      list_persona_conflicts: {
        Args: never
        Returns: {
          active_platform_admin: boolean
          active_tenant_roles: number
          email: string
          organization_ids: string[]
          user_id: string
        }[]
      }
      list_scan_events: {
        Args: { p_limit?: number; p_register?: string; p_verdict?: string }
        Returns: {
          code_masked: string
          decoded_at: string
          device_id: string
          id: string
          latency_ms: number
          received_at: string
          register_id: string
          session_id: string
          source: string
          verdict: string
          workflow: string
        }[]
      }
      log_commercial_event: {
        Args: {
          p_app_id?: string
          p_event_type: string
          p_org_id: string
          p_payload?: Json
          p_plan_id?: string
        }
        Returns: string
      }
      log_report_view: {
        Args: {
          p_branch_id?: string
          p_business_id?: string
          p_organization_id?: string
          p_params?: Json
          p_path?: string
          p_report_id: string
          p_report_type?: string
        }
        Returns: string
      }
      mark_alert_read: { Args: { p_alert_id: string }; Returns: boolean }
      mark_appointment_arrived: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      mark_onboarding_done: {
        Args: {
          p_business_id: string
          p_idempotency_key: string
          p_organization_id: string
        }
        Returns: undefined
      }
      mark_print_job_failed: {
        Args: { p_error: string; p_job_id: string }
        Returns: undefined
      }
      mask_sensitive_value: { Args: { p_value: string }; Returns: string }
      match_bill_with_landed_cost: {
        Args: { _actor: string; _bill_id: string; _landed_cost_bill_id: string }
        Returns: Json
      }
      merge_department: {
        Args: { p_source_department_id: string; p_target_department_id: string }
        Returns: {
          actor_user_id: string | null
          business_id: string | null
          change_kind: Database["public"]["Enums"]["org_change_kind"]
          created_at: string
          entity_id: string
          entity_kind: Database["public"]["Enums"]["org_entity_kind"]
          id: string
          occurred_at: string
          organization_id: string
          payload: Json
          summary: string | null
        }
        SetofOptions: {
          from: "*"
          to: "org_change_log"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      merge_table_orders: {
        Args: {
          p_notes?: string
          p_organization_id: string
          p_source_session_id: string
          p_target_session_id: string
          p_user_id?: string
        }
        Returns: Json
      }
      mf_accrue_penalties: {
        Args: { p_as_of?: string; p_business_id: string }
        Returns: number
      }
      mf_add_period: {
        Args: { p_date: string; p_freq: string; p_n: number }
        Returns: string
      }
      mf_bank_collection_batch: {
        Args: {
          p_bank_account_id: string
          p_banked_on?: string
          p_batch_id: string
          p_notes?: string
          p_reference?: string
        }
        Returns: string
      }
      mf_bank_disbursement_candidates: {
        Args: { _bank_transaction_id: string }
        Returns: Json
      }
      mf_can: {
        Args: {
          _branch_id: string
          _business_id: string
          _module: string
          _operation: string
        }
        Returns: boolean
      }
      mf_can_scoped: {
        Args: {
          _branch_id: string
          _business_id: string
          _module: string
          _officer_id: string
          _operation: string
        }
        Returns: boolean
      }
      mf_close_loan: {
        Args: { p_closed_on?: string; p_loan_id: string; p_notes?: string }
        Returns: string
      }
      mf_compute_loan_fees: { Args: { p_loan_id: string }; Returns: Json }
      mf_create_loan_from_application: {
        Args: {
          p_application_id: string
          p_expected_disbursement_date?: string
          p_first_installment_date?: string
        }
        Returns: string
      }
      mf_default_number_prefix: {
        Args: { p_sequence_key: string }
        Returns: string
      }
      mf_disburse_loan: {
        Args: {
          p_amount: number
          p_disbursed_on: string
          p_loan_id: string
          p_method: string
          p_notes?: string
          p_received_by_name?: string
          p_reference?: string
          p_source_account_id?: string
        }
        Returns: string
      }
      mf_disbursement_journal_entry: {
        Args: { _disbursement_id: string }
        Returns: string
      }
      mf_generate_schedule: { Args: { p_loan_id: string }; Returns: number }
      mf_is_portfolio_restricted: { Args: { p_user: string }; Returns: boolean }
      mf_loan_fee_total: {
        Args: { p_collection: string; p_loan_id: string }
        Returns: number
      }
      mf_loan_in_scope: { Args: { p_loan_id: string }; Returns: boolean }
      mf_method_mapping_key: { Args: { p_method: string }; Returns: string }
      mf_next_number: {
        Args: {
          p_branch_id: string
          p_business_id: string
          p_sequence_key: string
        }
        Returns: string
      }
      mf_number_period_key: {
        Args: { p_at?: string; p_reset: string }
        Returns: string
      }
      mf_officer_in_scope: { Args: { p_officer_id: string }; Returns: boolean }
      mf_pay_client_charge: {
        Args: {
          p_charge_id: string
          p_method?: string
          p_notes?: string
          p_paid_on?: string
          p_reference?: string
        }
        Returns: string
      }
      mf_periods_per_year: { Args: { p_freq: string }; Returns: number }
      mf_post_event: { Args: { p_event_id: string }; Returns: string }
      mf_raise_client_admission_fee: {
        Args: { p_charged_on?: string; p_client_id: string; p_notes?: string }
        Returns: string
      }
      mf_record_repayment: {
        Args: {
          p_amount: number
          p_batch_id?: string
          p_loan_id: string
          p_method: string
          p_notes?: string
          p_paid_on: string
          p_reference?: string
        }
        Returns: string
      }
      mf_reissue_loan: {
        Args: {
          p_additional_principal?: number
          p_expected_disbursement_date?: string
          p_first_installment_date?: string
          p_interest_rate?: number
          p_kind: string
          p_loan_id: string
          p_reason?: string
          p_term_installments?: number
        }
        Returns: string
      }
      mf_resolve_account: {
        Args: { p_branch_id: string; p_business_id: string; p_key: string }
        Returns: string
      }
      mf_reverse_client_charge: {
        Args: {
          p_charge_id: string
          p_effective_on?: string
          p_reason?: string
        }
        Returns: string
      }
      mf_reverse_disbursement: {
        Args: { p_disbursement_id: string; p_reason: string }
        Returns: string
      }
      mf_reverse_repayment: {
        Args: { p_reason: string; p_repayment_id: string }
        Returns: undefined
      }
      mf_write_off_loan: {
        Args: { p_loan_id: string; p_reason: string; p_written_off_on: string }
        Returns: string
      }
      migrate_opening_balances_to_je: {
        Args: { _business_id?: string; _entry_date?: string; _org_id: string }
        Returns: string
      }
      move_business_event_to_dlq: {
        Args: { p_id: string; p_reason: string }
        Returns: undefined
      }
      normalize_currency_code: { Args: { p_code: string }; Returns: string }
      normalize_display_to_base: {
        Args: { p_display: number; p_packaging_id: string }
        Returns: number
      }
      normalize_journal_source_type: {
        Args: { _source_type: string }
        Returns: string
      }
      normalize_profile_change_value: {
        Args: { p_field_key: string; p_raw: string }
        Returns: string
      }
      notify_admins_new_signup: {
        Args: {
          _email: string
          _full_name: string
          _signed_up_at: string
          _user_id: string
        }
        Returns: undefined
      }
      notify_app_trial_expiring: {
        Args: { p_app_id: string; p_days_left: number; p_org_id: string }
        Returns: undefined
      }
      notify_me_when_app_launches: {
        Args: { _app_id: string }
        Returns: string
      }
      pack_required_employee_fields: {
        Args: { p_business_id: string; p_module?: string }
        Returns: {
          blocks_onboarding: boolean
          blocks_payroll: boolean
          country_code: string
          data_type: string
          has_override: boolean
          help_text: string
          is_required: boolean
          label: string
          module: string
          pack_id: string
          requirement_key: string
          scope: string
          sort_order: number
          source: string
          validation_regex: string
        }[]
      }
      payment_is_bank_reconciled: {
        Args: { _payment_id: string }
        Returns: boolean
      }
      platform_delete_organization: {
        Args: { p_confirmation_token: string; p_org_id: string }
        Returns: Json
      }
      post_expense_gl: { Args: { p_expense_id: string }; Returns: Json }
      post_journal_entry_atomic:
        | {
            Args: {
              _business_id: string
              _created_by: string
              _currency?: string
              _description: string
              _entry_date: string
              _entry_number: string
              _exchange_rate?: number
              _is_adjusting: boolean
              _is_closing: boolean
              _lines: Json
              _org_id: string
              _reference: string
              _source_id: string
              _source_subtype?: string
              _source_type: string
            }
            Returns: string
          }
        | {
            Args: {
              _branch_id?: string
              _business_id: string
              _created_by: string
              _currency?: string
              _description: string
              _entry_date: string
              _entry_number: string
              _exchange_rate?: number
              _is_adjusting: boolean
              _is_closing: boolean
              _lines: Json
              _org_id: string
              _reference: string
              _source_id: string
              _source_subtype?: string
              _source_type: string
            }
            Returns: string
          }
        | {
            Args: {
              _amounts_in_document_currency?: boolean
              _branch_id?: string
              _business_id: string
              _created_by: string
              _currency?: string
              _description: string
              _entry_date: string
              _entry_number: string
              _exchange_rate?: number
              _is_adjusting: boolean
              _is_closing: boolean
              _is_opening_entry?: boolean
              _lines: Json
              _org_id: string
              _reference: string
              _source_id: string
              _source_subtype?: string
              _source_type: string
            }
            Returns: string
          }
        | {
            Args: {
              _business_id: string
              _created_by: string
              _description: string
              _entry_date: string
              _entry_number: string
              _is_adjusting: boolean
              _is_closing: boolean
              _lines: Json
              _org_id: string
              _reference: string
              _source_id: string
              _source_subtype?: string
              _source_type: string
            }
            Returns: string
          }
      post_journal_entry_status: {
        Args: { _entry_id: string; _user_id: string }
        Returns: undefined
      }
      post_source_to_gl: {
        Args: { p_source_id: string; p_source_type: string }
        Returns: string
      }
      preview_adjustment_offset_account: {
        Args: { p_business_id: string; p_reason: string; p_sign?: number }
        Returns: {
          account_code: string
          account_id: string
          account_name: string
        }[]
      }
      preview_organization_reset: { Args: { org_id: string }; Returns: Json }
      preview_transactional_reset: { Args: { org_id: string }; Returns: Json }
      print_job_insert: {
        Args: {
          p_branch_id: string
          p_business_id: string
          p_correlation_id: string
          p_device_assignment_id: string
          p_doc_id: string
          p_doc_type: string
          p_format: string
          p_intent: string
          p_media_profile_id: string
          p_parent_job_id?: string
          p_transport: string
        }
        Returns: string
      }
      print_job_mark_acked_by_id: { Args: { p_id: string }; Returns: number }
      print_job_mark_failed: {
        Args: { p_error: string; p_id: string }
        Returns: undefined
      }
      print_job_mark_sent: { Args: { p_id: string }; Returns: undefined }
      print_job_resend: { Args: { p_id: string }; Returns: string }
      print_jobs_settle: { Args: { p_ids: string[] }; Returns: number }
      print_jobs_strand: {
        Args: { p_ids: string[]; p_reason?: string }
        Returns: number
      }
      print_policies_resolve: {
        Args: {
          p_branch_id: string
          p_business_id: string
          p_document_type: string
          p_intent?: string
        }
        Returns: {
          ask_user: boolean
          auto_print: boolean
          copies: number
          device_assignment_id: string
          paper_format: string
          render_mode: string
        }[]
      }
      process_scheduled_organization_deletions: { Args: never; Returns: Json }
      project_analytic_account_id: {
        Args: { p_project_id: string }
        Returns: string
      }
      project_archive: { Args: { _project_id: string }; Returns: undefined }
      project_billing_rate_preview: {
        Args: { _employee_id?: string; _project_id: string }
        Returns: number
      }
      project_can_delete: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      project_can_read: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      project_can_write: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      project_employee_cost_rate: {
        Args: { _employee_id: string; _project_id: string }
        Returns: number
      }
      project_is_governor: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      project_status_transition_allowed: {
        Args: { _from: string; _to: string }
        Returns: boolean
      }
      promote_pack_version: {
        Args: {
          _business_id: string
          _pack_id: string
          _target_version: string
        }
        Returns: Json
      }
      promote_to_internal_user:
        | {
            Args: {
              p_new_role?: Database["public"]["Enums"]["app_role"]
              p_org_id: string
              p_user_id: string
            }
            Returns: Json
          }
        | {
            Args: { p_new_role?: string; p_org_id: string; p_user_id: string }
            Returns: Json
          }
      propose_ownership_transfer: {
        Args: {
          p_note?: string
          p_organization_id: string
          p_to_user_id: string
        }
        Returns: string
      }
      provision_additional_company: {
        Args: {
          _business_type?: string
          _country: string
          _currency: string
          _legal_name?: string
          _name: string
          _org_id: string
        }
        Returns: string
      }
      provision_company_full: {
        Args: {
          _business_type?: string
          _country: string
          _currency: string
          _is_first?: boolean
          _legal_name?: string
          _name: string
          _org_id: string
        }
        Returns: string
      }
      provision_default_chart_of_accounts: {
        Args: { _business_id: string; _country_code?: string; _org_id: string }
        Returns: number
      }
      provision_default_fiscal_periods: {
        Args: { _business_id: string; _org_id: string }
        Returns: number
      }
      provision_missing_system_accounts: {
        Args: {
          _business_id: string
          _mandatory_only?: boolean
          _organization_id: string
        }
        Returns: {
          account_id: string
          role_key: string
          status: string
        }[]
      }
      provision_system_account: {
        Args: {
          _business_id: string
          _organization_id: string
          _role_key: string
        }
        Returns: {
          account_type: Database["public"]["Enums"]["account_type"]
          business_id: string
          cash_flow_category: string | null
          code: string
          created_at: string
          current_balance: number
          description: string | null
          detail_type: string | null
          id: string
          is_active: boolean
          is_header: boolean
          is_system: boolean
          name: string
          opening_balance: number
          organization_id: string
          parent_id: string | null
          system_role: string | null
          template_account_id: string | null
          template_pack_account_id: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      publish_business_event: {
        Args: {
          p_actor_user_id?: string
          p_branch_id: string
          p_event_type: string
          p_idempotency_key: string
          p_org_id: string
          p_payload: Json
          p_source_doc_id: string
          p_source_doc_type: string
          p_warehouse_id: string
        }
        Returns: string
      }
      publish_localization_pack_version_sql: {
        Args: {
          p_notes?: string
          p_pack_id: string
          p_publisher?: string
          p_version: string
        }
        Returns: string
      }
      publish_platform_rates: { Args: { p_on_date?: string }; Returns: number }
      purchase_return_returnable_lines: {
        Args: { _goods_receipt_id: string }
        Returns: {
          description: string
          display_uom_id: string
          goods_receipt_item_id: string
          lot_number: string
          packaging_id: string
          product_id: string
          quantity_received: number
          quantity_returnable: number
          quantity_returned: number
          serial_number: string
          unit_cost: number
          uom_snapshot: string
        }[]
      }
      purge_scan_events: { Args: never; Returns: undefined }
      raise_ar_dispute: {
        Args: {
          _amount_disputed: number
          _branch_id?: string
          _business_id: string
          _client_request_id?: string
          _contact_id: string
          _currency?: string
          _dispute_type?: string
          _document_id?: string
          _reason?: string
        }
        Returns: string
      }
      reallocate_payment_atomic: {
        Args: {
          _actor?: string
          _new_allocations: Json
          _payment_id: string
          _reason?: string
        }
        Returns: Json
      }
      reclaim_stale_business_events: {
        Args: never
        Returns: {
          prior_worker: string
          reclaimed_id: string
        }[]
      }
      recompute_loan_schedule: { Args: { _loan_id: string }; Returns: number }
      reconcile_bank_transaction_atomic: {
        Args: {
          _category?: string
          _client_request_id?: string
          _create_gl?: boolean
          _entity_id?: string
          _offset_account_id?: string
          _recon_type: string
          _txn_id: string
          _user_id?: string
        }
        Returns: Json
      }
      reconcile_bank_transfer_atomic: {
        Args: {
          _dest_bank_account_id?: string
          _dest_txn_id?: string
          _source_txn_id: string
          _user_id?: string
        }
        Returns: Json
      }
      reconciliation_assistant_consume_quota: {
        Args: { _action: string; _bank_transaction_id: string }
        Returns: Json
      }
      reconciliation_assistant_record_outcome: {
        Args: {
          _model_used: string
          _response_time_ms: number
          _usage_id: string
          _was_degraded: boolean
        }
        Returns: undefined
      }
      record_advance_payment: {
        Args: {
          _advance_liability_account_id: string
          _amount: number
          _branch_id: string
          _business_id: string
          _contact_id: string
          _created_by: string
          _deposit_account_id: string
          _notes: string
          _org_id: string
          _payment_date: string
          _payment_method: string
          _receipt_number: string
          _reference: string
          _request_id?: string
        }
        Returns: Json
      }
      record_device_login: {
        Args: {
          p_browser?: string
          p_browser_version?: string
          p_city?: string
          p_country?: string
          p_country_code?: string
          p_device_fingerprint: string
          p_device_name?: string
          p_device_type?: string
          p_ip_address?: string
          p_latitude?: number
          p_login_method?: string
          p_longitude?: number
          p_os?: string
          p_os_version?: string
          p_region?: string
          p_user_agent?: string
        }
        Returns: Json
      }
      record_install_attempt_failure: {
        Args: {
          p_error_code: string
          p_error_message: string
          p_org_id: string
          p_plan_snapshot?: Json
          p_requested_app_id: string
          p_user_id: string
        }
        Returns: string
      }
      record_invitation_link_outcome: {
        Args: {
          p_employee_id?: string
          p_employee_linked: boolean
          p_invitation_email: string
          p_organization_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      record_multi_invoice_payment: {
        Args: {
          _allocations: Json
          _branch_id?: string
          _business_id: string
          _contact_id: string
          _created_by?: string
          _customer_credit_account_id?: string
          _deposit_account_id?: string
          _exchange_rate?: number
          _notes?: string
          _org_id: string
          _payment_date: string
          _payment_method?: string
          _receipt_number?: string
          _receivable_account_id?: string
          _reference?: string
          _request_id?: string
          _total_amount: number
        }
        Returns: Json
      }
      record_onboarding_attempt: {
        Args: { p_idempotency_key: string; p_step?: string }
        Returns: string
      }
      record_payment_atomic: {
        Args: {
          _amount: number
          _business_id: string
          _contact_id: string
          _created_by?: string
          _customer_credit_account_id?: string
          _deposit_account_id?: string
          _invoice_id: string
          _je_entry_number?: string
          _notes?: string
          _org_id: string
          _payment_date: string
          _payment_method?: string
          _receipt_number?: string
          _receivable_account_id?: string
          _reference?: string
          _request_id?: string
        }
        Returns: Json
      }
      record_payment_reversal_event: {
        Args: {
          _amount_after_applied?: number
          _amount_after_outstanding?: number
          _amount_before_applied?: number
          _amount_before_outstanding?: number
          _client_request_id: string
          _credit_note_id?: string
          _customer_refund_id?: string
          _notes?: string
          _op: string
          _payment_id: string
          _reason_code: Database["public"]["Enums"]["payment_reversal_reason"]
          _reason_text: string
          _reversal_journal_entry_id?: string
        }
        Returns: string
      }
      record_promise_to_pay: {
        Args: {
          _branch_id?: string
          _business_id: string
          _client_request_id?: string
          _contact_id: string
          _currency?: string
          _document_id?: string
          _expected_payment_date: string
          _notes?: string
          _promised_amount: number
        }
        Returns: string
      }
      recurring_next_start: {
        Args: {
          _anchor_day?: number
          _frequency: string
          _period_start: string
        }
        Returns: string
      }
      recurring_period_end:
        | {
            Args: { _frequency: string; _period_start: string }
            Returns: string
          }
        | {
            Args: {
              _anchor_day: number
              _frequency: string
              _period_start: string
            }
            Returns: string
          }
      refund_customer_atomic: {
        Args: {
          _amount: number
          _bank_account_id: string
          _client_request_id: string
          _payment_method: string
          _reason_code: Database["public"]["Enums"]["payment_reversal_reason"]
          _reason_text: string
          _reference: string
          _refund_date: string
          _source: string
          _source_id: string
        }
        Returns: string
      }
      register_governance_module: {
        Args: {
          p_depends_on?: string[]
          p_derived_projections?: string[]
          p_description?: string
          p_display_name: string
          p_export_fn?: string
          p_module_key: string
          p_owns_sequences?: string[]
          p_owns_storage_prefixes?: Json
          p_owns_tables?: string[]
          p_preview_fn?: string
          p_teardown_fn?: string
          p_version?: number
        }
        Returns: undefined
      }
      register_storage_object: {
        Args: { p_bucket: string; p_name: string; p_owner?: string }
        Returns: undefined
      }
      reinstate_supplier: {
        Args: { p_notes?: string; p_supplier_id: string }
        Returns: Json
      }
      remove_device: { Args: { p_device_id: string }; Returns: boolean }
      rename_department: {
        Args: { p_department_id: string; p_new_name: string }
        Returns: {
          actor_user_id: string | null
          business_id: string | null
          change_kind: Database["public"]["Enums"]["org_change_kind"]
          created_at: string
          entity_id: string
          entity_kind: Database["public"]["Enums"]["org_entity_kind"]
          id: string
          occurred_at: string
          organization_id: string
          payload: Json
          summary: string | null
        }
        SetofOptions: {
          from: "*"
          to: "org_change_log"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      renew_procurement_contract: {
        Args: {
          p_contract_id: string
          p_new_ceiling_value?: number
          p_new_end_date: string
        }
        Returns: Json
      }
      reopen_fiscal_period: {
        Args: { _period_id: string }
        Returns: {
          business_id: string
          closed_at: string | null
          closing_entry_id: string | null
          created_at: string
          end_date: string
          id: string
          is_closed: boolean
          locked_at: string | null
          locked_by: string | null
          name: string
          notes: string | null
          organization_id: string
          period_type: string | null
          start_date: string
          status: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "fiscal_periods"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      repair_finance_setup: {
        Args: { _business_id: string; _org_id: string }
        Returns: Json
      }
      repair_legacy_statutory_accounts: {
        Args: { _organization_id?: string }
        Returns: Json
      }
      request_app_access: {
        Args: { _app_id: string; _message?: string }
        Returns: string
      }
      request_reprint: {
        Args: {
          p_branch_id: string
          p_document_kind: string
          p_metadata?: Json
          p_org_id: string
          p_reason: string
          p_source_doc_id: string
          p_source_doc_type: string
        }
        Returns: string
      }
      request_reversal_approval: {
        Args: {
          _comment?: string
          _document_id: string
          _document_type: string
          _effective_date?: string
          _operation: string
          _reason_code: string
        }
        Returns: Json
      }
      requeue_print_job: {
        Args: { p_job_id: string }
        Returns: {
          acked_at: string | null
          artifact_id: string | null
          attempt_count: number
          branch_id: string | null
          business_id: string
          copies: number
          correlation_id: string
          created_at: string
          dedupe_key: string | null
          device_assignment_id: string | null
          disposition: Database["public"]["Enums"]["output_disposition"] | null
          doc_id: string | null
          doc_type: string
          document_record_id: string | null
          failed_at: string | null
          format: string
          hardware_role: string | null
          id: string
          intent: string
          last_error: string | null
          max_attempts: number
          media_profile_id: string | null
          medium: Database["public"]["Enums"]["output_medium"] | null
          next_attempt_at: string | null
          output_intent_id: string | null
          output_intent_target_id: string | null
          parent_job_id: string | null
          printer_profile_id: string | null
          processing_at: string | null
          render_params: Json
          requested_at: string
          requested_by: string | null
          requeued_count: number
          scenario: string
          sent_at: string | null
          status: Database["public"]["Enums"]["print_job_status"]
          transport: string
          triggered_source: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "print_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      require_exchange_rate: {
        Args: {
          p_business_id: string
          p_currency: string
          p_on_date: string
          p_org_id: string
        }
        Returns: number
      }
      reset_categories: {
        Args: { categories: string[]; org_id: string }
        Returns: Json
      }
      reset_module__ancillaries: { Args: { org_id: string }; Returns: Json }
      reset_module__banking: { Args: { org_id: string }; Returns: Json }
      reset_module__finance: { Args: { org_id: string }; Returns: Json }
      reset_module__fixed_assets: { Args: { org_id: string }; Returns: Json }
      reset_module__microfinance: {
        Args: {
          include_clients?: boolean
          include_products?: boolean
          org_id: string
        }
        Returns: Json
      }
      reset_module__sequences: { Args: { org_id: string }; Returns: Json }
      reset_module__transactions_ledger: {
        Args: { org_id: string }
        Returns: Json
      }
      reset_module__unlink_audit_refs: {
        Args: { org_id: string }
        Returns: Json
      }
      reset_my_signup: { Args: never; Returns: Json }
      reset_my_workspace: {
        Args: { confirmation_phrase: string; org_id: string }
        Returns: Json
      }
      reset_organization_data: {
        Args: { confirmation_token: string; org_id: string }
        Returns: Json
      }
      reset_statutory_override: {
        Args: {
          p_business_id: string
          p_country_code: string
          p_organization_id: string
          p_requirement_key: string
        }
        Returns: undefined
      }
      reset_transactional_data: {
        Args: {
          confirmation: string
          include_clients?: boolean
          include_products?: boolean
          org_id: string
        }
        Returns: Json
      }
      reset_user_pin: { Args: { p_device_fingerprint: string }; Returns: Json }
      resolve_adjustment_offset_account:
        | {
            Args: {
              p_business_id: string
              p_org_id: string
              p_reason: string
              p_sign: number
            }
            Returns: string
          }
        | {
            Args: {
              p_branch_id?: string
              p_business_id: string
              p_org_id: string
              p_reason: string
              p_sign: number
            }
            Returns: string
          }
      resolve_adjustment_unit_cost: {
        Args: {
          p_business_id: string
          p_org_id: string
          p_product_id: string
          p_provided: number
          p_warehouse_id: string
        }
        Returns: number
      }
      resolve_ar_dispute: {
        Args: {
          _dispute_id: string
          _resolution_note?: string
          _status: Database["public"]["Enums"]["ar_dispute_status"]
        }
        Returns: undefined
      }
      resolve_branch_scoped: {
        Args: { _branch_id: string; _business_id: string; _table_name: string }
        Returns: Json[]
      }
      resolve_branch_setting: {
        Args: { p_branch_id: string; p_setting_key: string }
        Returns: Json
      }
      resolve_consolidation_scope: {
        Args: { _as_of: string; _group_id: string }
        Returns: {
          base_currency: string
          blocker: string
          business_id: string
          business_name: string
          effective_from: string
          effective_to: string
          group_id: string
          group_name: string
          is_parent: boolean
          method: Database["public"]["Enums"]["consolidation_method"]
          ownership_percent: number
          presentation_currency: string
          requires_translation: boolean
        }[]
      }
      resolve_default_account:
        | {
            Args: { p_business_id: string; p_purpose: string }
            Returns: string
          }
        | {
            Args: {
              p_branch_id: string
              p_business_id: string
              p_purpose: string
            }
            Returns: string
          }
      resolve_default_account_binding: {
        Args: {
          _as_of?: string
          _branch_id?: string
          _business_id?: string
          _org_id: string
          _setting_key: string
        }
        Returns: string
      }
      resolve_default_permission_group: {
        Args: { _org_id: string; _role: string }
        Returns: string
      }
      resolve_exchange_rate: {
        Args: {
          p_business_id: string
          p_currency: string
          p_on_date: string
          p_org_id: string
        }
        Returns: number
      }
      resolve_expense_default_account: {
        Args: { p_business_id: string; p_org_id: string; p_setting_key: string }
        Returns: string
      }
      resolve_fiscal_jurisdiction: {
        Args: { p_business_id: string }
        Returns: string
      }
      resolve_fiscal_provider: {
        Args: { p_branch_id: string; p_org_id: string }
        Returns: string
      }
      resolve_fx_account: {
        Args: { p_business_id: string; p_purpose: string }
        Returns: string
      }
      resolve_fx_realized_account: {
        Args: { p_business_id: string; p_kind: string }
        Returns: string
      }
      resolve_fx_unrealized_account: {
        Args: { p_business_id: string; p_kind: string }
        Returns: string
      }
      resolve_liability_account_for_rule: {
        Args: {
          p_business_id: string
          p_country_code: string
          p_organization_id: string
          p_rule_code: string
        }
        Returns: string
      }
      resolve_line_base_quantity: {
        Args: {
          p_business_id: string
          p_display_quantity: number
          p_display_uom_id?: string
          p_packaging_id?: string
          p_product_id: string
        }
        Returns: Json
      }
      resolve_line_tax_rate: {
        Args: {
          p_business_id: string
          p_contact_id: string
          p_date?: string
          p_product_id: string
        }
        Returns: Json
      }
      resolve_my_employee: {
        Args: never
        Returns: {
          business_id: string
          can_self_link: boolean
          employee_id: string
          is_linked: boolean
          organization_id: string
        }[]
      }
      resolve_org_country_code: {
        Args: { p_business: string; p_org: string }
        Returns: string
      }
      resolve_output_intent: {
        Args: {
          p_branch_id?: string
          p_document_kind: string
          p_organization_id?: string
          p_scenario?: string
        }
        Returns: Json
      }
      resolve_pack_rule_schema: {
        Args: { _computation_kind: string; _rule_type: string }
        Returns: Json
      }
      resolve_payment_term: {
        Args: {
          p_business_id: string
          p_contact_id?: string
          p_organization_id: string
          p_override_term_id?: string
        }
        Returns: {
          days: number
          name: string
          payment_term_id: string
        }[]
      }
      resolve_posting_account: {
        Args: { p_branch_id?: string; p_business_id: string; p_key: string }
        Returns: string
      }
      resolve_project_billing_rate: {
        Args: { _employee_id?: string; _explicit?: number; _project_id: string }
        Returns: number
      }
      resolve_purchase_line_price: {
        Args: {
          p_branch_id?: string
          p_business_id: string
          p_on_date?: string
          p_product_id: string
          p_quantity?: number
          p_supplier_id?: string
        }
        Returns: Json
      }
      resolve_reversal_bank_block: {
        Args: {
          _actor?: string
          _document_id: string
          _document_type: string
          _reason?: string
        }
        Returns: Json
      }
      resolve_reversal_intent: {
        Args: { _document_id: string; _document_type: string }
        Returns: Json
      }
      resolve_reversal_intent_customer_refund: {
        Args: { _document_id: string }
        Returns: Json
      }
      resolve_reversal_intent_expense: {
        Args: { _document_id: string }
        Returns: Json
      }
      resolve_rule_recipients: {
        Args: {
          p_entity_id?: string
          p_entity_type?: string
          p_event: Database["public"]["Enums"]["sms_event_type"]
          p_org_id: string
          p_primary_contact_id?: string
          p_primary_phone?: string
        }
        Returns: {
          contact_id: string
          phone: string
          recipient_kind: string
          source: string
          user_id: string
        }[]
      }
      resolve_sales_exchange_rate: {
        Args: {
          p_business_id: string
          p_currency: string
          p_on_date: string
          p_org_id: string
        }
        Returns: number
      }
      resolve_sales_line_tax: {
        Args: {
          p_business_id: string
          p_contact_id: string
          p_date?: string
          p_product_id: string
          p_requested_rate?: number
          p_tax_rate_id?: string
        }
        Returns: Json
      }
      resolve_statutory_country_for_employee: {
        Args: { p_employee_id: string }
        Returns: string
      }
      resolve_supplier_defaults: {
        Args: { p_business_id: string; p_contact_id: string }
        Returns: Json
      }
      resolve_supplier_remittance: {
        Args: {
          p_business_id: string
          p_contact_id: string
          p_currency?: string
        }
        Returns: {
          account_name: string
          account_number_masked: string
          bank_account_id: string
          bank_name: string
          currency: string
          iban: string
          swift_bic: string
        }[]
      }
      resolve_timesheet_billing_rate: {
        Args: { _timesheet_id: string }
        Returns: number
      }
      resolve_trial_days: { Args: { p_app_id: string }; Returns: number }
      restore_department: {
        Args: { _department_id: string }
        Returns: {
          archived_at: string | null
          archived_by: string | null
          branch_id: string | null
          business_id: string
          code: string | null
          created_at: string | null
          description: string | null
          dissolved_at: string | null
          dissolved_by: string | null
          id: string
          is_active: boolean | null
          manager_id: string | null
          name: string
          organization_id: string
          parent_department_id: string | null
          status: Database["public"]["Enums"]["department_status"]
          updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "departments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      restore_owner_role: { Args: { p_org_id: string }; Returns: boolean }
      restore_so_reservation: {
        Args: {
          p_org_id: string
          p_product_id: string
          p_qty: number
          p_so_id: string
        }
        Returns: number
      }
      resume_my_invitation: { Args: never; Returns: Json }
      retry_failed_business_event: {
        Args: { p_event_id: string }
        Returns: {
          actor_user_id: string | null
          attempts: number
          branch_id: string | null
          claim_lease_seconds: number
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          event_type: string
          handler_scope: string
          id: string
          idempotency_key: string
          last_error: string | null
          org_id: string
          payload: Json
          source: string
          source_doc_id: string
          source_doc_type: string
          status: Database["public"]["Enums"]["business_event_status"]
          updated_at: string
          warehouse_id: string | null
          worker_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "business_event_outbox"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reversal_approval_requirement: {
        Args: {
          _document_id: string
          _document_type: string
          _effective_date?: string
          _operation?: string
        }
        Returns: Json
      }
      reversal_bank_lines: {
        Args: { _document_id: string; _document_type: string }
        Returns: Json
      }
      reverse_fx_revaluation_run: {
        Args: {
          _next_run_id?: string
          _reversal_date: string
          _run_id: string
          _user_id?: string
        }
        Returns: string
      }
      revoke_scanner_session: {
        Args: { p_session_id: string }
        Returns: number
      }
      rfq_attach_quotation_document: {
        Args: {
          _file_name: string
          _file_path: string
          _file_size?: number
          _kind?: string
          _mime_type?: string
          _quotation_id: string
        }
        Returns: string
      }
      rfq_cancel: { Args: { _reason: string; _rfq_id: string }; Returns: Json }
      rfq_convert_awards_to_po: { Args: { _rfq_id: string }; Returns: Json }
      rfq_expire_due: { Args: { _business_id: string }; Returns: number }
      rfq_expire_due_all: { Args: never; Returns: number }
      rfq_invitation_record_delivery: {
        Args: { _error?: string; _invitation_id: string; _state: string }
        Returns: undefined
      }
      rfq_invitation_resend: { Args: { _invitation_id: string }; Returns: Json }
      rfq_invitations_claim_for_delivery: {
        Args: { _limit?: number; _max_attempts?: number; _rfq_id: string }
        Returns: {
          attempt: number
          business_id: string
          contact_email: string
          invitation_id: string
          organization_id: string
          response_deadline: string
          rfq_number: string
          supplier_id: string
        }[]
      }
      rfq_record_quotation: {
        Args: {
          _allow_late?: boolean
          _header: Json
          _invitation_id: string
          _lines: Json
        }
        Returns: Json
      }
      rfq_release: { Args: { _rfq_id: string }; Returns: Json }
      rfq_remove_quotation_attachment: {
        Args: { _attachment_id: string }
        Returns: boolean
      }
      rfq_revise: { Args: { _reason: string; _rfq_id: string }; Returns: Json }
      rfq_snapshot_assert_solicitation: {
        Args: { _snapshot: Json }
        Returns: undefined
      }
      rfq_withdraw_quotation: {
        Args: { _quotation_id: string; _reason?: string }
        Returns: Json
      }
      rls_check_feature_access: {
        Args: { p_feature_key: string; p_org_id: string }
        Returns: boolean
      }
      rls_check_org_can_write: { Args: { _org_id: string }; Returns: boolean }
      rls_check_org_subscription_active: {
        Args: { p_org_id: string }
        Returns: boolean
      }
      run_identity_drift_check: {
        Args: never
        Returns: {
          business_count: number
          drift_kind: string
          org_name: string
          organization_id: string
          primary_business_id: string
          primary_legal_name: string
        }[]
      }
      save_integration_connection: {
        Args: {
          p_activate?: boolean
          p_auto_refresh_enabled?: boolean
          p_auto_refresh_interval_hours?: number
          p_capability_key: string
          p_credentials?: Json
          p_display_label?: string
          p_id?: string
          p_provider_id: string
        }
        Returns: string
      }
      schedule_organization_deletion: {
        Args: { p_grace_days?: number; p_org_id: string; p_reason?: string }
        Returns: Json
      }
      seed_app_data: {
        Args: { p_app_id: string; p_org_id: string }
        Returns: undefined
      }
      seed_default_journal_books: {
        Args: { _business_id: string }
        Returns: undefined
      }
      seed_default_loan_types: { Args: { _org_id: string }; Returns: undefined }
      seed_default_media_profiles: {
        Args: { p_org_id: string }
        Returns: number
      }
      seed_default_permission_groups: {
        Args: { p_org_id: string }
        Returns: undefined
      }
      seed_pack_readiness_rules: {
        Args: { _org_id: string; _pack_id: string }
        Returns: number
      }
      seed_project_permission_groups: {
        Args: { _org_id: string }
        Returns: undefined
      }
      set_branch_setting: {
        Args: {
          p_branch_id: string
          p_reason?: string
          p_setting_key: string
          p_setting_value: Json
        }
        Returns: Json
      }
      set_budget_status: {
        Args: {
          _budget_id: string
          _status: Database["public"]["Enums"]["budget_status"]
        }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          branch_id: string | null
          budget_code: string | null
          business_id: string | null
          created_at: string
          created_by: string | null
          currency_code: string | null
          description: string | null
          fiscal_year: number
          id: string
          name: string
          organization_id: string
          status: Database["public"]["Enums"]["budget_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "budgets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_email_provider_settings: {
        Args: {
          _clear_api_key?: boolean
          _platform_admin_reply_to_email?: string
          _resend_api_key?: string
          _resend_from_email?: string
          _resend_from_name?: string
          _support_reply_to_email?: string
        }
        Returns: Json
      }
      set_exchange_rate_override: {
        Args: {
          p_business_id: string
          p_effective_date?: string
          p_from_currency: string
          p_rate: number
          p_reason?: string
          p_to_currency: string
        }
        Returns: string
      }
      set_last_org_id: { Args: { p_org_id: string }; Returns: undefined }
      set_recurring_status_atomic: {
        Args: {
          p_reason?: string
          p_recurring_id: string
          p_status: string
          p_user_id?: string
        }
        Returns: Json
      }
      set_sms_provider_config: {
        Args: {
          p_account_sid?: string
          p_auth_token?: string
          p_business_id?: string
          p_daily_limit?: number
          p_help_message?: string
          p_inbound_enabled?: boolean
          p_is_enabled?: boolean
          p_messaging_service_sid?: string
          p_organization_id: string
          p_provider_mode?: string
          p_sender_phone?: string
        }
        Returns: string
      }
      set_user_pin: {
        Args: { p_device_fingerprint?: string; p_pin: string }
        Returns: Json
      }
      settings_jsonb_to_text: { Args: { p_value: Json }; Returns: string }
      sms_build_doc_vars: {
        Args: {
          p_amount: number
          p_branch_id: string
          p_business_id: string
          p_contact_id: string
          p_currency: string
          p_doc_number: string
          p_due_date: string
          p_extra?: Json
          p_org_id: string
        }
        Returns: Json
      }
      sms_enqueue_event: {
        Args: {
          p_business_id: string
          p_contact_id: string
          p_entity_id: string
          p_entity_type: string
          p_event: Database["public"]["Enums"]["sms_event_type"]
          p_org_id: string
          p_vars: Json
        }
        Returns: undefined
      }
      sms_event_rule_enabled: {
        Args: {
          p_event: Database["public"]["Enums"]["sms_event_type"]
          p_org_id: string
        }
        Returns: boolean
      }
      sms_increment_daily_counter: {
        Args: { config_id: string }
        Returns: number
      }
      sms_outbox_recover_stuck: {
        Args: { p_older_than_minutes?: number }
        Returns: number
      }
      snapshot_all_active_burndowns: { Args: never; Returns: number }
      snapshot_control_account_drift: { Args: never; Returns: number }
      start_appointment: {
        Args: { p_appointment_id: string }
        Returns: undefined
      }
      storage_gc_resolve_objects: {
        Args: {
          p_grace_interval?: string
          p_scope: string
          p_target_id?: string
        }
        Returns: {
          bucket_id: string
          entity_id: string
          entity_type: string
          object_name: string
          organization_id: string
          owner_kind: string
          owner_user_id: string
        }[]
      }
      store_ai_api_key: {
        Args: {
          p_api_key: string
          p_key_name: string
          p_priority?: number
          p_provider_id: string
        }
        Returns: string
      }
      submit_document_intent: {
        Args: {
          p_document_record_id: string
          p_override_targets?: Json
          p_scenario?: string
          p_triggered_source?: string
        }
        Returns: Json
      }
      subscription_active_for_org: { Args: { p_org: string }; Returns: boolean }
      suspend_supplier: {
        Args: { p_reason: string; p_supplier_id: string }
        Returns: Json
      }
      tasks_due_soon: {
        Args: { _biz?: string; _org: string; _within_days?: number }
        Returns: {
          assigned_to: string
          assignees: string[]
          deadline: string
          project_id: string
          task_id: string
          task_name: string
        }[]
      }
      terminate_procurement_contract: {
        Args: { p_contract_id: string; p_reason: string }
        Returns: Json
      }
      test_recurring_calendar: {
        Args: never
        Returns: {
          detail: string
          passed: boolean
          test_name: string
        }[]
      }
      test_recurring_invoicing_engine: {
        Args: never
        Returns: {
          detail: string
          passed: boolean
          test_name: string
        }[]
      }
      timesheet_effective_settings: {
        Args: { p_business_id: string; p_organization_id: string }
        Returns: {
          overtime_threshold_daily: number
          overtime_threshold_weekly: number
          week_start_day: number
        }[]
      }
      to_base_amount: {
        Args: {
          _amount: number
          _as_of?: string
          _business_id: string
          _currency: string
        }
        Returns: number
      }
      transfer_employee_primary_branch: {
        Args: {
          p_effective_from?: string
          p_employee_id: string
          p_new_branch_id: string
          p_notes?: string
        }
        Returns: string
      }
      transfer_organization_ownership: {
        Args: { _new_owner_user_id: string; _org_id: string }
        Returns: undefined
      }
      transfer_table_items: {
        Args: {
          p_items: Json
          p_notes?: string
          p_organization_id: string
          p_source_session_id: string
          p_target_session_id: string
          p_user_id?: string
        }
        Returns: Json
      }
      trust_device: {
        Args: { p_device_id: string; p_trust_days?: number }
        Returns: boolean
      }
      unapply_payment_atomic: {
        Args: {
          _client_request_id: string
          _payment_id: string
          _reason_code: Database["public"]["Enums"]["payment_reversal_reason"]
          _reason_text: string
          _reversal_date: string
        }
        Returns: string
      }
      unarchive_supplier: {
        Args: { p_notes?: string; p_supplier_id: string }
        Returns: Json
      }
      unblock_supplier: {
        Args: { p_notes?: string; p_supplier_id: string }
        Returns: Json
      }
      uninstall_app: {
        Args: { p_app_id: string; p_org_id: string }
        Returns: boolean
      }
      uninstall_localization_pack: {
        Args: { _business_id: string; _pack_id: string }
        Returns: Json
      }
      unreconcile_bank_transaction: {
        Args: {
          _bank_transaction_id: string
          _reason?: string
          _user_id?: string
        }
        Returns: Json
      }
      unreconcile_payment_atomic: {
        Args: { _actor?: string; _payment_id: string; _reason: string }
        Returns: Json
      }
      update_app_last_accessed: {
        Args: { p_app_id: string; p_org_id: string }
        Returns: undefined
      }
      update_journal_entry_atomic: {
        Args: {
          _description: string
          _entry_date: string
          _entry_id: string
          _is_adjusting?: boolean
          _is_closing?: boolean
          _lines?: Json
          _reference?: string
        }
        Returns: Json
      }
      update_overdue_compliance_items: { Args: never; Returns: undefined }
      update_own_employee_personal: { Args: { patch: Json }; Returns: string }
      update_portal_contact_self: {
        Args: {
          p_address_line1?: string
          p_address_line2?: string
          p_city?: string
          p_country?: string
          p_email?: string
          p_name?: string
          p_phone?: string
          p_postal_code?: string
          p_state?: string
        }
        Returns: {
          address_line1: string | null
          address_line2: string | null
          business_id: string | null
          child_address_type: string | null
          city: string | null
          commercial_partner_id: string | null
          company: string | null
          country: string | null
          created_at: string
          credit_hold: boolean | null
          credit_limit: number | null
          customer_rank: number
          default_currency: string | null
          default_expense_account_id: string | null
          default_payable_account_id: string | null
          default_payment_method_id: string | null
          default_receivable_account_id: string | null
          default_tax_rate_id: string | null
          email: string | null
          id: string
          is_active: boolean
          is_company: boolean
          is_default_billing: boolean
          is_default_shipping: boolean
          is_pinned: boolean | null
          is_sample_data: boolean
          name: string
          notes: string | null
          opening_balance: number | null
          opening_balance_date: string | null
          organization_id: string
          parent_contact_id: string | null
          payment_term_id: string | null
          phone: string | null
          portal_user_id: string | null
          postal_code: string | null
          sms_consent: boolean | null
          state: string | null
          supplier_rank: number
          tax_exemption_expiry: string | null
          tax_exemption_number: string | null
          tax_id: string | null
          type: Database["public"]["Enums"]["contact_type"] | null
          updated_at: string
          withholding_tax_rate: number | null
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_collector_assignment: {
        Args: {
          _business_id?: string
          _collector_user_id: string
          _contact_id: string
        }
        Returns: string
      }
      upsert_notification_alert_settings: {
        Args: {
          _business_id: string
          _organization_id: string
          _settings: Json
        }
        Returns: {
          business_id: string | null
          created_at: string | null
          daily_digest_enabled: boolean | null
          digest_send_hour: number | null
          digest_timezone: string | null
          expense_approval_required_above: number | null
          finance_alert_missing_je_enabled: boolean
          id: string
          large_payment_threshold: number | null
          organization_id: string
          overdue_escalation_enabled: boolean | null
          overdue_reminder_frequency_days: number | null
          payment_received_notify: boolean | null
          updated_at: string | null
          weekly_digest_enabled: boolean | null
        }
        SetofOptions: {
          from: "*"
          to: "notification_alert_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_organization_invitation:
        | {
            Args: {
              p_email: string
              p_employee_id?: string
              p_expires_days?: number
              p_invited_by?: string
              p_organization_id: string
              p_permission_group_ids?: string[]
              p_role: Database["public"]["Enums"]["app_role"]
              p_user_type?: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_branch_ids?: string[]
              p_branch_scope?: Database["public"]["Enums"]["branch_scope_mode"]
              p_email: string
              p_employee_id?: string
              p_expires_days?: number
              p_invited_by?: string
              p_organization_id: string
              p_permission_group_ids?: string[]
              p_primary_branch_id?: string
              p_role: Database["public"]["Enums"]["app_role"]
              p_user_type?: string
            }
            Returns: Json
          }
      upsert_system_account: {
        Args: {
          _account_type: string
          _business_id: string
          _description?: string
          _detail_type: string
          _is_header?: boolean
          _organization_id: string
          _parent_id?: string
          _suggested_code: string
          _suggested_name: string
          _system_role: string
        }
        Returns: string
      }
      user_assigned_branch_ids: {
        Args: { _org_id: string; _user_id: string }
        Returns: {
          branch_id: string
        }[]
      }
      user_belongs_to_org:
        | { Args: { _org_id: string; _user_id: string }; Returns: boolean }
        | { Args: { org_id: string }; Returns: boolean }
      user_branch_scope: {
        Args: { _org_id: string; _user_id: string }
        Returns: Database["public"]["Enums"]["branch_scope_mode"]
      }
      user_can_access_branch: {
        Args: { _branch_id: string; _user_id: string }
        Returns: boolean
      }
      user_can_access_business: {
        Args: { _business_id: string; _user_id: string }
        Returns: boolean
      }
      user_can_view_employee_private: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      user_has_app_access: {
        Args: { _app_id: string; _org_id: string; _user_id: string }
        Returns: boolean
      }
      user_has_business_access: {
        Args: { _business_id: string; _user_id: string }
        Returns: boolean
      }
      user_has_module_permission:
        | {
            Args: {
              _business_id: string
              _module: string
              _operation: string
              _org_id: string
              _user_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              _module: string
              _operation: string
              _org_id: string
              _user_id: string
            }
            Returns: boolean
          }
      user_has_module_permission_in_branch: {
        Args: {
          _branch_id: string
          _module: string
          _operation: string
          _org_id: string
          _user_id: string
        }
        Returns: boolean
      }
      user_has_org_access: { Args: { org_id: string }; Returns: boolean }
      user_is_project_member: {
        Args: { _project_id: string; _user_id: string }
        Returns: boolean
      }
      user_owns_migration_session: {
        Args: { p_session_id: string }
        Returns: boolean
      }
      users_share_organization: {
        Args: { _user_id_1: string; _user_id_2: string }
        Returns: boolean
      }
      validate_jsonb_against_schema: {
        Args: { _path?: string; _payload: Json; _schema: Json }
        Returns: string[]
      }
      validate_required_system_roles: {
        Args: { _business_id: string }
        Returns: {
          is_required: boolean
          setting_key: string
          suggested_account_type: string
        }[]
      }
      verify_company_isolation: {
        Args: never
        Returns: {
          actual_business_id: string
          detail: string
          expected_business_id: string
          record_id: string
          table_name: string
        }[]
      }
      verify_onboarding_contract: { Args: never; Returns: Json }
      verify_pin_full: {
        Args: { p_email: string; p_pin: string }
        Returns: Json
      }
      verify_pin_unauthenticated: {
        Args: { p_pin: string; p_user_id: string }
        Returns: Json
      }
      verify_user_pin:
        | {
            Args: { p_device_fingerprint: string; p_pin: string }
            Returns: Json
          }
        | { Args: { p_pin: string }; Returns: Json }
      void_journal_entry_atomic: {
        Args: {
          _entry_id: string
          _entry_number?: string
          _reason: string
          _reversal_date?: string
          _user_id?: string
        }
        Returns: string
      }
      void_payment_atomic: {
        Args: {
          _actor?: string
          _client_request_id?: string
          _payment_id: string
          _reason: string
          _reason_code?: string
          _void_date?: string
        }
        Returns: Json
      }
      wet_impact_metrics: {
        Args: { _business_id: string; _org_id: string }
        Returns: {
          code: string
          employees_last_90d: number
          leave_types_routed: number
          rows_last_90d: number
          rules_referencing: number
          work_entry_type_id: string
        }[]
      }
    }
    Enums: {
      account_type: "asset" | "liability" | "equity" | "income" | "expense"
      advance_recovery_method: "lump_sum" | "installments"
      advance_repayment_status:
        | "scheduled"
        | "partial"
        | "recovered"
        | "skipped"
        | "written_off"
      app_lifecycle_state:
        | "active"
        | "trial"
        | "trial_expired"
        | "suspended"
        | "uninstalled_readonly"
        | "archived"
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
        | "branch_manager"
        | "loan_officer"
        | "credit_officer"
        | "collections_officer"
        | "auditor"
      application_stage:
        | "applied"
        | "screen"
        | "interview"
        | "assessment"
        | "offer"
        | "hired"
        | "rejected"
        | "withdrawn"
      ar_dispute_status: "open" | "resolved" | "rejected"
      ar_promise_status: "open" | "kept" | "broken" | "cancelled"
      bank_account_lifecycle_status: "draft" | "active" | "suspended" | "closed"
      bill_match_exception_state:
        | "none"
        | "pending_review"
        | "approved"
        | "rejected"
      bill_match_state:
        | "matched"
        | "under_billed"
        | "over_billed"
        | "price_variance"
        | "no_po"
      bill_status:
        | "draft"
        | "open"
        | "partial"
        | "paid"
        | "overdue"
        | "cancelled"
        | "submitted"
        | "approved"
      branch_scope_mode: "all" | "assigned" | "own_portfolio"
      budget_status: "draft" | "active" | "closed"
      bulk_operation_kind:
        | "import_employees"
        | "export_employees"
        | "bulk_department_transfer"
        | "bulk_manager_reassignment"
        | "bulk_salary_revision"
        | "bulk_contract_creation"
        | "bulk_location_transfer"
      bulk_operation_status:
        | "draft"
        | "validating"
        | "preview_ready"
        | "applying"
        | "completed"
        | "failed"
        | "cancelled"
      business_event_status:
        | "pending"
        | "running"
        | "succeeded"
        | "failed"
        | "skipped"
      consolidation_elimination_class:
        | "intercompany_balance"
        | "intercompany_trading"
      consolidation_elimination_difference_policy:
        | "refuse"
        | "post_difference"
        | "post_to_cta"
      consolidation_method: "full" | "proportional" | "equity" | "excluded"
      contact_type: "customer" | "supplier" | "both"
      contract_amendment_kind:
        | "renewal"
        | "salary_revision"
        | "position_change"
        | "location_change"
        | "schedule_change"
        | "allowance_change"
        | "end_date_change"
        | "other"
      credit_note_status: "draft" | "issued" | "applied" | "void" | "refunded"
      crm_lead_status: "new" | "qualified" | "proposition" | "won" | "lost"
      custom_deduction_kind:
        | "recurring"
        | "one_time"
        | "voluntary"
        | "involuntary"
      custom_deduction_status:
        | "pending"
        | "approved"
        | "active"
        | "suspended"
        | "cancelled"
        | "completed"
      custom_deduction_tax_treatment: "pre_tax" | "post_tax"
      department_status: "active" | "archived" | "dissolved"
      document_output_trigger:
        | "manual"
        | "auto"
        | "preview_only"
        | "download_only"
      dunning_action_type:
        | "reminder"
        | "statement"
        | "call"
        | "escalate"
        | "legal"
      employee_advance_status:
        | "requested"
        | "approved"
        | "disbursed"
        | "recovering"
        | "recovered"
        | "cancelled"
      employee_lifecycle_event_type:
        | "candidate_created"
        | "application_submitted"
        | "offer_extended"
        | "offer_accepted"
        | "offer_declined"
        | "hired"
        | "onboarding_started"
        | "onboarding_completed"
        | "probation_started"
        | "probation_ended"
        | "probation_extended"
        | "contract_created"
        | "contract_activated"
        | "contract_renewed"
        | "contract_amended"
        | "contract_expired"
        | "salary_revised"
        | "position_changed"
        | "department_transferred"
        | "location_transferred"
        | "manager_changed"
        | "promoted"
        | "demoted"
        | "suspended"
        | "reinstated"
        | "leave_of_absence_started"
        | "leave_of_absence_ended"
        | "termination_initiated"
        | "terminated"
        | "offboarding_started"
        | "offboarding_completed"
        | "final_settlement_paid"
        | "archived"
        | "unarchived"
        | "custom"
        | "user_invited"
        | "user_invitation_revoked"
        | "user_invitation_accepted"
        | "user_linked"
        | "user_unlinked"
        | "profile_change_requested"
        | "profile_change_approved"
        | "profile_change_rejected"
        | "identity_email_change_requested"
        | "mfa_enrolled"
        | "mfa_unenrolled"
      employee_lifecycle_status:
        | "draft"
        | "active"
        | "on_leave"
        | "notice"
        | "suspended"
        | "exited"
        | "archived"
      estimate_status:
        | "draft"
        | "sent"
        | "viewed"
        | "accepted"
        | "rejected"
        | "expired"
        | "converted"
      expense_status:
        | "pending"
        | "approved"
        | "rejected"
        | "paid"
        | "draft"
        | "submitted"
        | "voided"
      garnishment_cap_rule:
        | "fixed_amount"
        | "percent_disposable"
        | "lesser_of_fixed_or_pct"
      garnishment_kind:
        | "child_support"
        | "tax_levy"
        | "court_order"
        | "student_loan"
        | "creditor"
        | "wage_assignment"
        | "other"
      garnishment_status:
        | "active"
        | "suspended"
        | "satisfied"
        | "released"
        | "expired"
        | "draft"
        | "pending_approval"
        | "approved"
        | "terminated_unsatisfied"
      goal_status:
        | "not_started"
        | "in_progress"
        | "at_risk"
        | "completed"
        | "cancelled"
      goods_receipt_discrepancy_resolution:
        | "pending"
        | "vendor_credit"
        | "insurance_claim"
        | "accept_and_move_on"
        | "return_to_vendor"
      goods_receipt_discrepancy_type:
        | "over"
        | "short"
        | "damaged"
        | "wrong_item"
        | "expired"
        | "quality_hold"
      inbound_shipment_status:
        | "draft"
        | "dispatched"
        | "in_transit"
        | "arrived"
        | "received"
        | "cancelled"
      interview_recommendation:
        | "strong_no"
        | "no"
        | "maybe"
        | "yes"
        | "strong_yes"
      invoice_status:
        | "draft"
        | "sent"
        | "viewed"
        | "partial"
        | "paid"
        | "overdue"
        | "cancelled"
        | "confirmed"
        | "voided"
      journal_status: "draft" | "posted" | "void" | "reversed"
      landed_cost_allocation_basis:
        | "value"
        | "quantity"
        | "weight"
        | "volume"
        | "manual"
      landed_cost_voucher_status:
        | "draft"
        | "pending_approval"
        | "allocated"
        | "posted"
        | "reversed"
        | "cancelled"
      legal_order_calc_model:
        | "fixed"
        | "percent_disposable"
        | "percent_gross"
        | "balance_remaining"
        | "statutory_formula"
      legal_order_cap_membership: "in_pool" | "exempt" | "always_first"
      legal_order_completion_rule:
        | "by_balance"
        | "by_date"
        | "by_court_order"
        | "indefinite"
      legal_order_remittance_batch_status:
        | "draft"
        | "generated"
        | "settled"
        | "cancelled"
      offer_status:
        | "draft"
        | "sent"
        | "accepted"
        | "declined"
        | "withdrawn"
        | "rescinded"
      org_change_kind:
        | "department_created"
        | "department_renamed"
        | "department_merged"
        | "department_closed"
        | "department_reopened"
        | "position_created"
        | "position_renamed"
        | "position_closed"
        | "location_created"
        | "location_renamed"
        | "location_closed"
      org_entity_kind: "department" | "job_position" | "work_location"
      output_disposition:
        | "print"
        | "email"
        | "download"
        | "archive"
        | "fiscal"
        | "webhook"
      output_medium: "pdf" | "escpos" | "zpl" | "html"
      output_scope: "system" | "tenant" | "organization" | "branch"
      pack_requirement_module:
        | "core"
        | "payroll"
        | "attendance"
        | "timesheets"
        | "benefits"
        | "hr"
      pack_requirement_scope:
        | "employee_field"
        | "statutory_identifier"
        | "payroll_rule"
        | "account_mapping"
        | "onboarding_item"
      pack_requirement_source: "pack" | "tenant_override"
      payment_batch_status:
        | "draft"
        | "pending"
        | "confirmed"
        | "partially_paid"
        | "paid"
        | "cancelled"
        | "approved"
        | "locked"
        | "exported"
        | "transmitted"
        | "reversed"
        | "failed"
      payment_direction: "received" | "made"
      payment_method:
        | "cash"
        | "bank_transfer"
        | "credit_card"
        | "check"
        | "other"
        | "mpesa"
        | "mobile_money"
      payment_method_enum:
        | "cash"
        | "check"
        | "bank_transfer"
        | "credit_card"
        | "mobile_money"
        | "other"
      payment_method_type: "bank" | "mobile_money" | "cash"
      payment_reversal_reason:
        | "data_entry_error"
        | "duplicate_payment"
        | "bank_transfer_failed"
        | "wrong_invoice_applied"
        | "customer_refund_requested"
        | "invoice_cancelled_keep_as_credit"
        | "invoice_cancelled_keep_as_advance"
        | "pre_refund_unapply"
        | "payment_currency_mismatch"
        | "payment_reallocated"
        | "invoice_voided_cascade"
      payroll_bank_export_file_status:
        | "generated"
        | "transmitted"
        | "acknowledged"
        | "rejected"
        | "cancelled"
      payroll_input_unit: "amount" | "hours" | "days" | "count"
      payroll_payment_item_status:
        | "pending"
        | "held"
        | "exported"
        | "sent"
        | "paid"
        | "failed"
        | "cancelled"
        | "reversed"
      payroll_period_status:
        | "open"
        | "preparing"
        | "processing"
        | "awaiting_approval"
        | "posted"
        | "paid"
        | "closed"
        | "reopened"
        | "cancelled"
        | "archived"
      payroll_run_issue_severity: "info" | "warning" | "blocker"
      payroll_run_scope_kind:
        | "company"
        | "branch"
        | "department"
        | "employee_set"
        | "final_settlement"
      payslip_event_type:
        | "generated"
        | "recomputed"
        | "approved"
        | "posted"
        | "paid"
        | "cancelled"
        | "corrected"
        | "superseded"
        | "reissued"
        | "viewed"
        | "downloaded"
        | "emailed"
        | "signed"
      payslip_input_source:
        | "attendance"
        | "leave"
        | "timesheet"
        | "manual"
        | "contract"
        | "work_entry"
        | "override"
        | "variable_input"
        | "loan"
        | "garnishment"
        | "reimbursement"
        | "termination_payout"
        | "statutory_rule"
        | "salary_structure"
        | "retro"
        | "expense"
        | "benefit"
      payslip_line_category:
        | "earning"
        | "deduction"
        | "employer_contribution"
        | "statutory_employee"
        | "statutory_employer"
        | "reimbursement"
        | "benefit"
        | "loan_repayment"
        | "net"
      performance_cycle_status: "draft" | "open" | "in_progress" | "closed"
      performance_review_status:
        | "not_started"
        | "in_progress"
        | "submitted"
        | "acknowledged"
      po_status:
        | "draft"
        | "sent"
        | "partial_received"
        | "received"
        | "cancelled"
        | "submitted"
        | "approved"
        | "acknowledged"
        | "closed"
        | "revised"
        | "rejected"
      pos_barcode_rule_kind: "weighted_price" | "weighted_qty" | "plu"
      pos_kitchen_status:
        | "new"
        | "sent"
        | "cooking"
        | "ready"
        | "served"
        | "cancelled"
      pos_payment_session_status:
        | "open"
        | "balanced"
        | "committed"
        | "cancelled"
        | "abandoned"
      pos_payment_session_tender_state:
        | "idle"
        | "authorizing"
        | "approved"
        | "captured"
        | "reversed"
        | "failed"
      pos_reversal_type:
        | "cancel_pre_payment"
        | "void_post_payment"
        | "return_refund"
      pos_statement_close_kind:
        | "shift_close"
        | "trading_day_close"
        | "historical_backfill"
        | "force_close"
      pos_statement_posting_status:
        | "pending"
        | "posted"
        | "historical"
        | "reversed"
      pos_table_session_status:
        | "open"
        | "ordered"
        | "served"
        | "paid"
        | "closed"
      pos_terminal_mode: "test" | "live"
      print_job_status:
        | "queued"
        | "sent"
        | "acked"
        | "failed"
        | "abandoned"
        | "processing"
        | "dead_letter"
      printer_workflow:
        | "receiving"
        | "shipping"
        | "shelf_edge"
        | "product_tag"
        | "kitchen_hot"
        | "kitchen_bar"
        | "bar"
        | "payslip"
        | "asset_tag"
        | "generic"
      procurement_contract_status:
        | "draft"
        | "pending_approval"
        | "active"
        | "suspended"
        | "expired"
        | "terminated"
        | "closed"
      product_identifier_kind:
        | "gtin"
        | "sku"
        | "pack"
        | "supplier"
        | "internal"
        | "plu"
        | "alias"
      product_identifier_source:
        | "manual"
        | "import"
        | "asn"
        | "gs1"
        | "migration"
        | "pos"
      product_identifier_status: "active" | "inactive" | "archived"
      product_lifecycle_status: "draft" | "active" | "discontinued" | "archived"
      product_type: "product" | "service"
      qc_resolution_kind:
        | "accept"
        | "reject_return_to_supplier"
        | "reject_scrap"
        | "conditional_release"
        | "rework"
        | "use_as_is"
      requisition_status:
        | "draft"
        | "open"
        | "on_hold"
        | "filled"
        | "closed"
        | "cancelled"
      rfq_status: "draft" | "sent" | "received" | "closed" | "cancelled"
      sales_order_status:
        | "draft"
        | "confirmed"
        | "processing"
        | "partial"
        | "fulfilled"
        | "invoiced"
        | "cancelled"
      sms_event_type:
        | "invoice_posted"
        | "payment_received"
        | "invoice_overdue"
        | "po_sent"
        | "estimate_sent"
        | "delivery_shipped"
        | "payment_reminder"
        | "credit_note_issued"
        | "sales_order_confirmed"
        | "recurring_invoice_generated"
        | "expense_approved"
        | "expense_rejected"
        | "payroll_processed"
        | "low_stock_alert"
        | "customer_statement_sent"
        | "out_of_stock"
      sms_provider: "twilio"
      sms_recipient_type:
        | "customer"
        | "vendor"
        | "custom"
        | "employee"
        | "internal"
      sms_status: "queued" | "sent" | "delivered" | "failed" | "undelivered"
      statutory_component_party: "employee" | "employer"
      statutory_component_type:
        | "mandatory"
        | "voluntary"
        | "employer"
        | "top_up"
      statutory_reporting_side:
        | "employee"
        | "employer"
        | "total"
        | "taxable"
        | "count"
      stock_location_type:
        | "internal"
        | "quarantine"
        | "staging"
        | "transit"
        | "customer"
        | "vendor"
        | "scrap"
        | "production"
        | "view"
      stock_location_usage:
        | "storage"
        | "pick"
        | "pack"
        | "ship"
        | "receive"
        | "inspection"
        | "virtual"
      stock_serial_status:
        | "in_stock"
        | "reserved"
        | "shipped"
        | "returned"
        | "scrapped"
      training_enrollment_status:
        | "enrolled"
        | "in_progress"
        | "completed"
        | "dropped"
        | "failed"
      transaction_type:
        | "invoice"
        | "payment"
        | "expense"
        | "transfer"
        | "adjustment"
        | "opening_balance"
      wms_appointment_state:
        | "requested"
        | "confirmed"
        | "arrived"
        | "docked"
        | "unloading"
        | "unloaded"
        | "closed"
        | "no_show"
        | "cancelled"
      wms_count_state: "draft" | "counting" | "review" | "posted" | "cancelled"
      wms_count_strategy: "abc" | "random" | "targeted"
      wms_count_variance_reason:
        | "damage"
        | "mis_pick"
        | "wrong_location"
        | "shrinkage"
        | "receiving_error"
        | "production_error"
        | "duplicate_count"
        | "unknown_loss"
        | "system_error"
      wms_crossdock_demand_type:
        | "sales_order"
        | "transfer"
        | "replenishment"
        | "production"
      wms_crossdock_state:
        | "detected"
        | "qualified"
        | "rejected"
        | "approved"
        | "staging"
        | "staged"
        | "loaded"
        | "completed"
        | "expired"
        | "broken"
        | "cancelled"
      wms_dock_type: "receiving" | "shipping" | "both"
      wms_exception_class:
        | "informational"
        | "operational"
        | "quality"
        | "safety"
        | "compliance"
        | "financial"
        | "customer_impact"
      wms_exception_event_type:
        | "created"
        | "classified"
        | "assigned"
        | "reassigned"
        | "acknowledged"
        | "state_changed"
        | "evidence_added"
        | "link_added"
        | "comment_added"
        | "escalated"
        | "sla_breached"
        | "resolved"
        | "closed"
        | "reopened"
      wms_exception_evidence_type:
        | "barcode_scan"
        | "rfid_read"
        | "photo"
        | "signature"
        | "weight"
        | "dimension"
        | "temperature"
        | "humidity"
        | "sensor_reading"
        | "inspection_report"
        | "supplier_document"
        | "system_snapshot"
        | "external_reference"
        | "note"
      wms_exception_kind:
        | "receiving_discrepancy"
        | "qc_fail"
        | "short_pick"
        | "count_variance"
        | "damaged_lpn"
        | "unknown_scan"
        | "invalid_bin"
        | "capacity_exceeded"
        | "stale_task"
        | "other"
        | "billing_unpriced"
        | "over_receipt"
        | "under_receipt"
        | "missing_carton"
        | "wrong_supplier"
        | "wrong_asn"
        | "damaged_goods"
        | "failed_inspection"
        | "asn_mismatch"
        | "negative_inventory"
        | "phantom_inventory"
        | "duplicate_serial"
        | "batch_mismatch"
        | "expired_stock"
        | "unexpected_movement"
        | "wrong_location"
        | "unsafe_storage"
        | "quarantine_violation"
        | "wrong_item_picked"
        | "wrong_batch_picked"
        | "pick_sla_breach"
        | "weight_mismatch"
        | "incorrect_package"
        | "carton_missing"
        | "wrong_carrier"
        | "missed_dispatch"
        | "shipment_blocked"
        | "missed_appointment"
        | "dock_congestion"
        | "incorrect_trailer"
        | "trailer_overstay"
        | "seal_mismatch"
        | "demand_disappeared"
        | "routing_conflict"
        | "repeated_discrepancy"
        | "abandoned_task"
        | "productivity_target_missed"
        | "device_offline"
        | "printer_offline"
        | "scanner_offline"
        | "rfid_failure"
        | "conveyor_failure"
        | "scale_failure"
        | "sensor_failure"
        | "return_discrepancy"
        | "integration_failure"
        | "data_sync_failure"
      wms_exception_link_type:
        | "goods_receipt"
        | "purchase_order"
        | "asn"
        | "receiving_session"
        | "count_session"
        | "qc_inspection"
        | "pick_wave"
        | "manifest"
        | "delivery_note"
        | "invoice"
        | "bill"
        | "task"
        | "license_plate"
        | "return_order"
        | "dock_appointment"
        | "trailer_visit"
        | "product"
        | "supplier"
        | "carrier"
        | "operator"
        | "warehouse_location"
        | "other"
      wms_exception_owner_role:
        | "warehouse_supervisor"
        | "receiving_lead"
        | "inventory_controller"
        | "quality_inspector"
        | "pick_lead"
        | "pack_lead"
        | "shipping_lead"
        | "dock_coordinator"
        | "yard_marshal"
        | "maintenance"
        | "labour_planner"
        | "finance"
        | "procurement"
        | "it_support"
      wms_exception_resolution_kind:
        | "short_scan"
        | "damaged"
        | "wrong_bin"
        | "wrong_lp"
        | "legacy_short_dispatch"
        | "miscount"
        | "process_error"
        | "system_error"
        | "other"
        | "supplier_error"
        | "carrier_error"
        | "operator_error"
        | "equipment_failure"
        | "integration_error"
        | "data_entry_error"
        | "theft_or_loss"
        | "expiry"
        | "no_fault_found"
        | "duplicate_exception"
      wms_exception_state:
        | "open"
        | "acknowledged"
        | "investigating"
        | "resolved"
        | "wont_fix"
        | "escalated"
        | "cancelled"
      wms_lpn_status:
        | "open"
        | "sealed"
        | "shipped"
        | "retired"
        | "draft"
        | "receiving"
        | "putaway"
        | "stored"
        | "picked"
        | "packed"
        | "staged"
        | "loaded"
        | "quarantined"
        | "consumed"
        | "voided"
      wms_lpn_type: "pallet" | "carton" | "tote" | "other"
      wms_manifest_state:
        | "draft"
        | "loading"
        | "closed"
        | "dispatched"
        | "cancelled"
      wms_pack_state: "open" | "sealed" | "labeled" | "staged" | "voided"
      wms_packaging_class:
        | "carton"
        | "envelope"
        | "tube"
        | "crate"
        | "pallet"
        | "tote"
        | "insulated"
        | "drum"
        | "bag"
      wms_packaging_lifecycle: "draft" | "active" | "restricted" | "retired"
      wms_putaway_strategy_type:
        | "fixed_bin"
        | "consolidate"
        | "same_category"
        | "fefo_zone"
        | "hazmat_zone"
        | "cold_chain"
        | "heavy_zone"
        | "velocity_slot"
        | "empty_bin"
        | "nearest"
        | "overflow"
        | "bulk"
        | "general_priority"
      wms_qc_state:
        | "pending"
        | "in_progress"
        | "passed"
        | "failed"
        | "conditional"
        | "closed"
        | "cancelled"
      wms_receiving_state:
        | "open"
        | "unloading"
        | "captured"
        | "discrepant"
        | "posted"
        | "closed"
        | "cancelled"
      wms_replen_order_state:
        | "planned"
        | "approved"
        | "dispatched"
        | "in_progress"
        | "completed"
        | "short"
        | "cancelled"
      wms_replen_scope:
        | "warehouse"
        | "zone"
        | "category"
        | "product"
        | "pick_face"
      wms_replen_strategy: "min_max" | "demand_driven" | "topoff" | "manual"
      wms_return_condition:
        | "unopened"
        | "opened"
        | "damaged"
        | "defective"
        | "expired"
        | "missing_accessories"
        | "incorrect_item"
      wms_return_disposition:
        | "restock"
        | "scrap"
        | "repair"
        | "return_to_vendor"
        | "hold"
        | "quarantine"
        | "refurbish"
        | "quality_hold"
      wms_return_kind: "customer" | "vendor" | "internal" | "transfer"
      wms_return_line_inspection_state:
        | "pending"
        | "inspecting"
        | "passed"
        | "failed"
        | "conditional"
        | "waived"
      wms_return_state:
        | "draft"
        | "authorized"
        | "in_transit"
        | "received"
        | "inspecting"
        | "disposed"
        | "closed"
        | "cancelled"
      wms_sscc_entity: "carton" | "lpn" | "pallet" | "manifest"
      wms_sscc_status: "assigned" | "voided"
      wms_task_state:
        | "pending"
        | "assigned"
        | "in_progress"
        | "done"
        | "cancelled"
        | "available"
        | "claimed"
        | "completed"
        | "exception"
        | "paused"
        | "resumed"
      wms_task_type:
        | "putaway"
        | "pick"
        | "pack"
        | "load"
        | "count"
        | "replenish"
        | "move"
        | "qc"
        | "yard_move"
      wms_wave_state:
        | "draft"
        | "planned"
        | "ready"
        | "released"
        | "picking"
        | "picked"
        | "packing"
        | "suspended"
        | "packed"
        | "completed"
        | "archived"
        | "cancelled"
      work_location_type: "office" | "remote" | "other"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      advance_recovery_method: ["lump_sum", "installments"],
      advance_repayment_status: [
        "scheduled",
        "partial",
        "recovered",
        "skipped",
        "written_off",
      ],
      app_lifecycle_state: [
        "active",
        "trial",
        "trial_expired",
        "suspended",
        "uninstalled_readonly",
        "archived",
      ],
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
        "branch_manager",
        "loan_officer",
        "credit_officer",
        "collections_officer",
        "auditor",
      ],
      application_stage: [
        "applied",
        "screen",
        "interview",
        "assessment",
        "offer",
        "hired",
        "rejected",
        "withdrawn",
      ],
      ar_dispute_status: ["open", "resolved", "rejected"],
      ar_promise_status: ["open", "kept", "broken", "cancelled"],
      bank_account_lifecycle_status: ["draft", "active", "suspended", "closed"],
      bill_match_exception_state: [
        "none",
        "pending_review",
        "approved",
        "rejected",
      ],
      bill_match_state: [
        "matched",
        "under_billed",
        "over_billed",
        "price_variance",
        "no_po",
      ],
      bill_status: [
        "draft",
        "open",
        "partial",
        "paid",
        "overdue",
        "cancelled",
        "submitted",
        "approved",
      ],
      branch_scope_mode: ["all", "assigned", "own_portfolio"],
      budget_status: ["draft", "active", "closed"],
      bulk_operation_kind: [
        "import_employees",
        "export_employees",
        "bulk_department_transfer",
        "bulk_manager_reassignment",
        "bulk_salary_revision",
        "bulk_contract_creation",
        "bulk_location_transfer",
      ],
      bulk_operation_status: [
        "draft",
        "validating",
        "preview_ready",
        "applying",
        "completed",
        "failed",
        "cancelled",
      ],
      business_event_status: [
        "pending",
        "running",
        "succeeded",
        "failed",
        "skipped",
      ],
      consolidation_elimination_class: [
        "intercompany_balance",
        "intercompany_trading",
      ],
      consolidation_elimination_difference_policy: [
        "refuse",
        "post_difference",
        "post_to_cta",
      ],
      consolidation_method: ["full", "proportional", "equity", "excluded"],
      contact_type: ["customer", "supplier", "both"],
      contract_amendment_kind: [
        "renewal",
        "salary_revision",
        "position_change",
        "location_change",
        "schedule_change",
        "allowance_change",
        "end_date_change",
        "other",
      ],
      credit_note_status: ["draft", "issued", "applied", "void", "refunded"],
      crm_lead_status: ["new", "qualified", "proposition", "won", "lost"],
      custom_deduction_kind: [
        "recurring",
        "one_time",
        "voluntary",
        "involuntary",
      ],
      custom_deduction_status: [
        "pending",
        "approved",
        "active",
        "suspended",
        "cancelled",
        "completed",
      ],
      custom_deduction_tax_treatment: ["pre_tax", "post_tax"],
      department_status: ["active", "archived", "dissolved"],
      document_output_trigger: [
        "manual",
        "auto",
        "preview_only",
        "download_only",
      ],
      dunning_action_type: [
        "reminder",
        "statement",
        "call",
        "escalate",
        "legal",
      ],
      employee_advance_status: [
        "requested",
        "approved",
        "disbursed",
        "recovering",
        "recovered",
        "cancelled",
      ],
      employee_lifecycle_event_type: [
        "candidate_created",
        "application_submitted",
        "offer_extended",
        "offer_accepted",
        "offer_declined",
        "hired",
        "onboarding_started",
        "onboarding_completed",
        "probation_started",
        "probation_ended",
        "probation_extended",
        "contract_created",
        "contract_activated",
        "contract_renewed",
        "contract_amended",
        "contract_expired",
        "salary_revised",
        "position_changed",
        "department_transferred",
        "location_transferred",
        "manager_changed",
        "promoted",
        "demoted",
        "suspended",
        "reinstated",
        "leave_of_absence_started",
        "leave_of_absence_ended",
        "termination_initiated",
        "terminated",
        "offboarding_started",
        "offboarding_completed",
        "final_settlement_paid",
        "archived",
        "unarchived",
        "custom",
        "user_invited",
        "user_invitation_revoked",
        "user_invitation_accepted",
        "user_linked",
        "user_unlinked",
        "profile_change_requested",
        "profile_change_approved",
        "profile_change_rejected",
        "identity_email_change_requested",
        "mfa_enrolled",
        "mfa_unenrolled",
      ],
      employee_lifecycle_status: [
        "draft",
        "active",
        "on_leave",
        "notice",
        "suspended",
        "exited",
        "archived",
      ],
      estimate_status: [
        "draft",
        "sent",
        "viewed",
        "accepted",
        "rejected",
        "expired",
        "converted",
      ],
      expense_status: [
        "pending",
        "approved",
        "rejected",
        "paid",
        "draft",
        "submitted",
        "voided",
      ],
      garnishment_cap_rule: [
        "fixed_amount",
        "percent_disposable",
        "lesser_of_fixed_or_pct",
      ],
      garnishment_kind: [
        "child_support",
        "tax_levy",
        "court_order",
        "student_loan",
        "creditor",
        "wage_assignment",
        "other",
      ],
      garnishment_status: [
        "active",
        "suspended",
        "satisfied",
        "released",
        "expired",
        "draft",
        "pending_approval",
        "approved",
        "terminated_unsatisfied",
      ],
      goal_status: [
        "not_started",
        "in_progress",
        "at_risk",
        "completed",
        "cancelled",
      ],
      goods_receipt_discrepancy_resolution: [
        "pending",
        "vendor_credit",
        "insurance_claim",
        "accept_and_move_on",
        "return_to_vendor",
      ],
      goods_receipt_discrepancy_type: [
        "over",
        "short",
        "damaged",
        "wrong_item",
        "expired",
        "quality_hold",
      ],
      inbound_shipment_status: [
        "draft",
        "dispatched",
        "in_transit",
        "arrived",
        "received",
        "cancelled",
      ],
      interview_recommendation: [
        "strong_no",
        "no",
        "maybe",
        "yes",
        "strong_yes",
      ],
      invoice_status: [
        "draft",
        "sent",
        "viewed",
        "partial",
        "paid",
        "overdue",
        "cancelled",
        "confirmed",
        "voided",
      ],
      journal_status: ["draft", "posted", "void", "reversed"],
      landed_cost_allocation_basis: [
        "value",
        "quantity",
        "weight",
        "volume",
        "manual",
      ],
      landed_cost_voucher_status: [
        "draft",
        "pending_approval",
        "allocated",
        "posted",
        "reversed",
        "cancelled",
      ],
      legal_order_calc_model: [
        "fixed",
        "percent_disposable",
        "percent_gross",
        "balance_remaining",
        "statutory_formula",
      ],
      legal_order_cap_membership: ["in_pool", "exempt", "always_first"],
      legal_order_completion_rule: [
        "by_balance",
        "by_date",
        "by_court_order",
        "indefinite",
      ],
      legal_order_remittance_batch_status: [
        "draft",
        "generated",
        "settled",
        "cancelled",
      ],
      offer_status: [
        "draft",
        "sent",
        "accepted",
        "declined",
        "withdrawn",
        "rescinded",
      ],
      org_change_kind: [
        "department_created",
        "department_renamed",
        "department_merged",
        "department_closed",
        "department_reopened",
        "position_created",
        "position_renamed",
        "position_closed",
        "location_created",
        "location_renamed",
        "location_closed",
      ],
      org_entity_kind: ["department", "job_position", "work_location"],
      output_disposition: [
        "print",
        "email",
        "download",
        "archive",
        "fiscal",
        "webhook",
      ],
      output_medium: ["pdf", "escpos", "zpl", "html"],
      output_scope: ["system", "tenant", "organization", "branch"],
      pack_requirement_module: [
        "core",
        "payroll",
        "attendance",
        "timesheets",
        "benefits",
        "hr",
      ],
      pack_requirement_scope: [
        "employee_field",
        "statutory_identifier",
        "payroll_rule",
        "account_mapping",
        "onboarding_item",
      ],
      pack_requirement_source: ["pack", "tenant_override"],
      payment_batch_status: [
        "draft",
        "pending",
        "confirmed",
        "partially_paid",
        "paid",
        "cancelled",
        "approved",
        "locked",
        "exported",
        "transmitted",
        "reversed",
        "failed",
      ],
      payment_direction: ["received", "made"],
      payment_method: [
        "cash",
        "bank_transfer",
        "credit_card",
        "check",
        "other",
        "mpesa",
        "mobile_money",
      ],
      payment_method_enum: [
        "cash",
        "check",
        "bank_transfer",
        "credit_card",
        "mobile_money",
        "other",
      ],
      payment_method_type: ["bank", "mobile_money", "cash"],
      payment_reversal_reason: [
        "data_entry_error",
        "duplicate_payment",
        "bank_transfer_failed",
        "wrong_invoice_applied",
        "customer_refund_requested",
        "invoice_cancelled_keep_as_credit",
        "invoice_cancelled_keep_as_advance",
        "pre_refund_unapply",
        "payment_currency_mismatch",
        "payment_reallocated",
        "invoice_voided_cascade",
      ],
      payroll_bank_export_file_status: [
        "generated",
        "transmitted",
        "acknowledged",
        "rejected",
        "cancelled",
      ],
      payroll_input_unit: ["amount", "hours", "days", "count"],
      payroll_payment_item_status: [
        "pending",
        "held",
        "exported",
        "sent",
        "paid",
        "failed",
        "cancelled",
        "reversed",
      ],
      payroll_period_status: [
        "open",
        "preparing",
        "processing",
        "awaiting_approval",
        "posted",
        "paid",
        "closed",
        "reopened",
        "cancelled",
        "archived",
      ],
      payroll_run_issue_severity: ["info", "warning", "blocker"],
      payroll_run_scope_kind: [
        "company",
        "branch",
        "department",
        "employee_set",
        "final_settlement",
      ],
      payslip_event_type: [
        "generated",
        "recomputed",
        "approved",
        "posted",
        "paid",
        "cancelled",
        "corrected",
        "superseded",
        "reissued",
        "viewed",
        "downloaded",
        "emailed",
        "signed",
      ],
      payslip_input_source: [
        "attendance",
        "leave",
        "timesheet",
        "manual",
        "contract",
        "work_entry",
        "override",
        "variable_input",
        "loan",
        "garnishment",
        "reimbursement",
        "termination_payout",
        "statutory_rule",
        "salary_structure",
        "retro",
        "expense",
        "benefit",
      ],
      payslip_line_category: [
        "earning",
        "deduction",
        "employer_contribution",
        "statutory_employee",
        "statutory_employer",
        "reimbursement",
        "benefit",
        "loan_repayment",
        "net",
      ],
      performance_cycle_status: ["draft", "open", "in_progress", "closed"],
      performance_review_status: [
        "not_started",
        "in_progress",
        "submitted",
        "acknowledged",
      ],
      po_status: [
        "draft",
        "sent",
        "partial_received",
        "received",
        "cancelled",
        "submitted",
        "approved",
        "acknowledged",
        "closed",
        "revised",
        "rejected",
      ],
      pos_barcode_rule_kind: ["weighted_price", "weighted_qty", "plu"],
      pos_kitchen_status: [
        "new",
        "sent",
        "cooking",
        "ready",
        "served",
        "cancelled",
      ],
      pos_payment_session_status: [
        "open",
        "balanced",
        "committed",
        "cancelled",
        "abandoned",
      ],
      pos_payment_session_tender_state: [
        "idle",
        "authorizing",
        "approved",
        "captured",
        "reversed",
        "failed",
      ],
      pos_reversal_type: [
        "cancel_pre_payment",
        "void_post_payment",
        "return_refund",
      ],
      pos_statement_close_kind: [
        "shift_close",
        "trading_day_close",
        "historical_backfill",
        "force_close",
      ],
      pos_statement_posting_status: [
        "pending",
        "posted",
        "historical",
        "reversed",
      ],
      pos_table_session_status: ["open", "ordered", "served", "paid", "closed"],
      pos_terminal_mode: ["test", "live"],
      print_job_status: [
        "queued",
        "sent",
        "acked",
        "failed",
        "abandoned",
        "processing",
        "dead_letter",
      ],
      printer_workflow: [
        "receiving",
        "shipping",
        "shelf_edge",
        "product_tag",
        "kitchen_hot",
        "kitchen_bar",
        "bar",
        "payslip",
        "asset_tag",
        "generic",
      ],
      procurement_contract_status: [
        "draft",
        "pending_approval",
        "active",
        "suspended",
        "expired",
        "terminated",
        "closed",
      ],
      product_identifier_kind: [
        "gtin",
        "sku",
        "pack",
        "supplier",
        "internal",
        "plu",
        "alias",
      ],
      product_identifier_source: [
        "manual",
        "import",
        "asn",
        "gs1",
        "migration",
        "pos",
      ],
      product_identifier_status: ["active", "inactive", "archived"],
      product_lifecycle_status: ["draft", "active", "discontinued", "archived"],
      product_type: ["product", "service"],
      qc_resolution_kind: [
        "accept",
        "reject_return_to_supplier",
        "reject_scrap",
        "conditional_release",
        "rework",
        "use_as_is",
      ],
      requisition_status: [
        "draft",
        "open",
        "on_hold",
        "filled",
        "closed",
        "cancelled",
      ],
      rfq_status: ["draft", "sent", "received", "closed", "cancelled"],
      sales_order_status: [
        "draft",
        "confirmed",
        "processing",
        "partial",
        "fulfilled",
        "invoiced",
        "cancelled",
      ],
      sms_event_type: [
        "invoice_posted",
        "payment_received",
        "invoice_overdue",
        "po_sent",
        "estimate_sent",
        "delivery_shipped",
        "payment_reminder",
        "credit_note_issued",
        "sales_order_confirmed",
        "recurring_invoice_generated",
        "expense_approved",
        "expense_rejected",
        "payroll_processed",
        "low_stock_alert",
        "customer_statement_sent",
        "out_of_stock",
      ],
      sms_provider: ["twilio"],
      sms_recipient_type: [
        "customer",
        "vendor",
        "custom",
        "employee",
        "internal",
      ],
      sms_status: ["queued", "sent", "delivered", "failed", "undelivered"],
      statutory_component_party: ["employee", "employer"],
      statutory_component_type: [
        "mandatory",
        "voluntary",
        "employer",
        "top_up",
      ],
      statutory_reporting_side: [
        "employee",
        "employer",
        "total",
        "taxable",
        "count",
      ],
      stock_location_type: [
        "internal",
        "quarantine",
        "staging",
        "transit",
        "customer",
        "vendor",
        "scrap",
        "production",
        "view",
      ],
      stock_location_usage: [
        "storage",
        "pick",
        "pack",
        "ship",
        "receive",
        "inspection",
        "virtual",
      ],
      stock_serial_status: [
        "in_stock",
        "reserved",
        "shipped",
        "returned",
        "scrapped",
      ],
      training_enrollment_status: [
        "enrolled",
        "in_progress",
        "completed",
        "dropped",
        "failed",
      ],
      transaction_type: [
        "invoice",
        "payment",
        "expense",
        "transfer",
        "adjustment",
        "opening_balance",
      ],
      wms_appointment_state: [
        "requested",
        "confirmed",
        "arrived",
        "docked",
        "unloading",
        "unloaded",
        "closed",
        "no_show",
        "cancelled",
      ],
      wms_count_state: ["draft", "counting", "review", "posted", "cancelled"],
      wms_count_strategy: ["abc", "random", "targeted"],
      wms_count_variance_reason: [
        "damage",
        "mis_pick",
        "wrong_location",
        "shrinkage",
        "receiving_error",
        "production_error",
        "duplicate_count",
        "unknown_loss",
        "system_error",
      ],
      wms_crossdock_demand_type: [
        "sales_order",
        "transfer",
        "replenishment",
        "production",
      ],
      wms_crossdock_state: [
        "detected",
        "qualified",
        "rejected",
        "approved",
        "staging",
        "staged",
        "loaded",
        "completed",
        "expired",
        "broken",
        "cancelled",
      ],
      wms_dock_type: ["receiving", "shipping", "both"],
      wms_exception_class: [
        "informational",
        "operational",
        "quality",
        "safety",
        "compliance",
        "financial",
        "customer_impact",
      ],
      wms_exception_event_type: [
        "created",
        "classified",
        "assigned",
        "reassigned",
        "acknowledged",
        "state_changed",
        "evidence_added",
        "link_added",
        "comment_added",
        "escalated",
        "sla_breached",
        "resolved",
        "closed",
        "reopened",
      ],
      wms_exception_evidence_type: [
        "barcode_scan",
        "rfid_read",
        "photo",
        "signature",
        "weight",
        "dimension",
        "temperature",
        "humidity",
        "sensor_reading",
        "inspection_report",
        "supplier_document",
        "system_snapshot",
        "external_reference",
        "note",
      ],
      wms_exception_kind: [
        "receiving_discrepancy",
        "qc_fail",
        "short_pick",
        "count_variance",
        "damaged_lpn",
        "unknown_scan",
        "invalid_bin",
        "capacity_exceeded",
        "stale_task",
        "other",
        "billing_unpriced",
        "over_receipt",
        "under_receipt",
        "missing_carton",
        "wrong_supplier",
        "wrong_asn",
        "damaged_goods",
        "failed_inspection",
        "asn_mismatch",
        "negative_inventory",
        "phantom_inventory",
        "duplicate_serial",
        "batch_mismatch",
        "expired_stock",
        "unexpected_movement",
        "wrong_location",
        "unsafe_storage",
        "quarantine_violation",
        "wrong_item_picked",
        "wrong_batch_picked",
        "pick_sla_breach",
        "weight_mismatch",
        "incorrect_package",
        "carton_missing",
        "wrong_carrier",
        "missed_dispatch",
        "shipment_blocked",
        "missed_appointment",
        "dock_congestion",
        "incorrect_trailer",
        "trailer_overstay",
        "seal_mismatch",
        "demand_disappeared",
        "routing_conflict",
        "repeated_discrepancy",
        "abandoned_task",
        "productivity_target_missed",
        "device_offline",
        "printer_offline",
        "scanner_offline",
        "rfid_failure",
        "conveyor_failure",
        "scale_failure",
        "sensor_failure",
        "return_discrepancy",
        "integration_failure",
        "data_sync_failure",
      ],
      wms_exception_link_type: [
        "goods_receipt",
        "purchase_order",
        "asn",
        "receiving_session",
        "count_session",
        "qc_inspection",
        "pick_wave",
        "manifest",
        "delivery_note",
        "invoice",
        "bill",
        "task",
        "license_plate",
        "return_order",
        "dock_appointment",
        "trailer_visit",
        "product",
        "supplier",
        "carrier",
        "operator",
        "warehouse_location",
        "other",
      ],
      wms_exception_owner_role: [
        "warehouse_supervisor",
        "receiving_lead",
        "inventory_controller",
        "quality_inspector",
        "pick_lead",
        "pack_lead",
        "shipping_lead",
        "dock_coordinator",
        "yard_marshal",
        "maintenance",
        "labour_planner",
        "finance",
        "procurement",
        "it_support",
      ],
      wms_exception_resolution_kind: [
        "short_scan",
        "damaged",
        "wrong_bin",
        "wrong_lp",
        "legacy_short_dispatch",
        "miscount",
        "process_error",
        "system_error",
        "other",
        "supplier_error",
        "carrier_error",
        "operator_error",
        "equipment_failure",
        "integration_error",
        "data_entry_error",
        "theft_or_loss",
        "expiry",
        "no_fault_found",
        "duplicate_exception",
      ],
      wms_exception_state: [
        "open",
        "acknowledged",
        "investigating",
        "resolved",
        "wont_fix",
        "escalated",
        "cancelled",
      ],
      wms_lpn_status: [
        "open",
        "sealed",
        "shipped",
        "retired",
        "draft",
        "receiving",
        "putaway",
        "stored",
        "picked",
        "packed",
        "staged",
        "loaded",
        "quarantined",
        "consumed",
        "voided",
      ],
      wms_lpn_type: ["pallet", "carton", "tote", "other"],
      wms_manifest_state: [
        "draft",
        "loading",
        "closed",
        "dispatched",
        "cancelled",
      ],
      wms_pack_state: ["open", "sealed", "labeled", "staged", "voided"],
      wms_packaging_class: [
        "carton",
        "envelope",
        "tube",
        "crate",
        "pallet",
        "tote",
        "insulated",
        "drum",
        "bag",
      ],
      wms_packaging_lifecycle: ["draft", "active", "restricted", "retired"],
      wms_putaway_strategy_type: [
        "fixed_bin",
        "consolidate",
        "same_category",
        "fefo_zone",
        "hazmat_zone",
        "cold_chain",
        "heavy_zone",
        "velocity_slot",
        "empty_bin",
        "nearest",
        "overflow",
        "bulk",
        "general_priority",
      ],
      wms_qc_state: [
        "pending",
        "in_progress",
        "passed",
        "failed",
        "conditional",
        "closed",
        "cancelled",
      ],
      wms_receiving_state: [
        "open",
        "unloading",
        "captured",
        "discrepant",
        "posted",
        "closed",
        "cancelled",
      ],
      wms_replen_order_state: [
        "planned",
        "approved",
        "dispatched",
        "in_progress",
        "completed",
        "short",
        "cancelled",
      ],
      wms_replen_scope: [
        "warehouse",
        "zone",
        "category",
        "product",
        "pick_face",
      ],
      wms_replen_strategy: ["min_max", "demand_driven", "topoff", "manual"],
      wms_return_condition: [
        "unopened",
        "opened",
        "damaged",
        "defective",
        "expired",
        "missing_accessories",
        "incorrect_item",
      ],
      wms_return_disposition: [
        "restock",
        "scrap",
        "repair",
        "return_to_vendor",
        "hold",
        "quarantine",
        "refurbish",
        "quality_hold",
      ],
      wms_return_kind: ["customer", "vendor", "internal", "transfer"],
      wms_return_line_inspection_state: [
        "pending",
        "inspecting",
        "passed",
        "failed",
        "conditional",
        "waived",
      ],
      wms_return_state: [
        "draft",
        "authorized",
        "in_transit",
        "received",
        "inspecting",
        "disposed",
        "closed",
        "cancelled",
      ],
      wms_sscc_entity: ["carton", "lpn", "pallet", "manifest"],
      wms_sscc_status: ["assigned", "voided"],
      wms_task_state: [
        "pending",
        "assigned",
        "in_progress",
        "done",
        "cancelled",
        "available",
        "claimed",
        "completed",
        "exception",
        "paused",
        "resumed",
      ],
      wms_task_type: [
        "putaway",
        "pick",
        "pack",
        "load",
        "count",
        "replenish",
        "move",
        "qc",
        "yard_move",
      ],
      wms_wave_state: [
        "draft",
        "planned",
        "ready",
        "released",
        "picking",
        "picked",
        "packing",
        "suspended",
        "packed",
        "completed",
        "archived",
        "cancelled",
      ],
      work_location_type: ["office", "remote", "other"],
    },
  },
} as const
