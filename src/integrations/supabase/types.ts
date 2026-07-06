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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agents: {
        Row: {
          chatwoot_token: string | null
          created_at: string
          email: string
          hubspot_email: string | null
          hubspot_owner_id: string | null
          id: string
          name: string
          role: string
          status: string
        }
        Insert: {
          chatwoot_token?: string | null
          created_at?: string
          email?: string
          hubspot_email?: string | null
          hubspot_owner_id?: string | null
          id: string
          name?: string
          role?: string
          status?: string
        }
        Update: {
          chatwoot_token?: string | null
          created_at?: string
          email?: string
          hubspot_email?: string | null
          hubspot_owner_id?: string | null
          id?: string
          name?: string
          role?: string
          status?: string
        }
        Relationships: []
      }
      call_logs: {
        Row: {
          agent_id: string | null
          ai_summary: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          duration_seconds: number | null
          hubspot_contact_id: string | null
          id: string
          recording_url: string | null
          status: string | null
          transcript: string | null
        }
        Insert: {
          agent_id?: string | null
          ai_summary?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          duration_seconds?: number | null
          hubspot_contact_id?: string | null
          id?: string
          recording_url?: string | null
          status?: string | null
          transcript?: string | null
        }
        Update: {
          agent_id?: string | null
          ai_summary?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          duration_seconds?: number | null
          hubspot_contact_id?: string | null
          id?: string
          recording_url?: string | null
          status?: string | null
          transcript?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      chatwoot_events: {
        Row: {
          account_id: number | null
          conversation_id: number | null
          created_at: string | null
          event_type: string
          id: number
          message_type: string | null
        }
        Insert: {
          account_id?: number | null
          conversation_id?: number | null
          created_at?: string | null
          event_type: string
          id?: number
          message_type?: string | null
        }
        Update: {
          account_id?: number | null
          conversation_id?: number | null
          created_at?: string | null
          event_type?: string
          id?: number
          message_type?: string | null
        }
        Relationships: []
      }
      contact_owner_cache: {
        Row: {
          hubspot_owner_id: string | null
          phone: string
          updated_at: string
        }
        Insert: {
          hubspot_owner_id?: string | null
          phone: string
          updated_at?: string
        }
        Update: {
          hubspot_owner_id?: string | null
          phone?: string
          updated_at?: string
        }
        Relationships: []
      }
      hubspot_cache: {
        Row: {
          cached_at: string
          contact_data: Json | null
          deal_data: Json | null
          phone: string
        }
        Insert: {
          cached_at?: string
          contact_data?: Json | null
          deal_data?: Json | null
          phone: string
        }
        Update: {
          cached_at?: string
          contact_data?: Json | null
          deal_data?: Json | null
          phone?: string
        }
        Relationships: []
      }
      messages_history: {
        Row: {
          attachments: Json | null
          chatwoot_message_id: number
          contact_phone: string
          content: string | null
          content_attributes: Json | null
          conversation_id: number
          created_at_chatwoot: string
          id: number
          message_type: number
          sender_name: string | null
          sender_type: string | null
          status: string | null
          synced_at: string
        }
        Insert: {
          attachments?: Json | null
          chatwoot_message_id: number
          contact_phone: string
          content?: string | null
          content_attributes?: Json | null
          conversation_id: number
          created_at_chatwoot: string
          id?: number
          message_type: number
          sender_name?: string | null
          sender_type?: string | null
          status?: string | null
          synced_at?: string
        }
        Update: {
          attachments?: Json | null
          chatwoot_message_id?: number
          contact_phone?: string
          content?: string | null
          content_attributes?: Json | null
          conversation_id?: number
          created_at_chatwoot?: string
          id?: number
          message_type?: number
          sender_name?: string | null
          sender_type?: string | null
          status?: string | null
          synced_at?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          chatwoot_account_id: string | null
          chatwoot_token: string | null
          chatwoot_url: string | null
          hubspot_token: string | null
          hubspot_visible_fields: Json | null
          id: number
          updated_at: string
        }
        Insert: {
          chatwoot_account_id?: string | null
          chatwoot_token?: string | null
          chatwoot_url?: string | null
          hubspot_token?: string | null
          hubspot_visible_fields?: Json | null
          id?: number
          updated_at?: string
        }
        Update: {
          chatwoot_account_id?: string | null
          chatwoot_token?: string | null
          chatwoot_url?: string | null
          hubspot_token?: string | null
          hubspot_visible_fields?: Json | null
          id?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
