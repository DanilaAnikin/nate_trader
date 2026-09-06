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
          alpaca_account_number: string | null
          alpaca_key_secret_id: string | null
          alpaca_secret_secret_id: string | null
          color: string
          created_at: string
          /** Bumped by rotation and deletion; bound into every refresh token. */
          credential_version: number
          /** Client-generated, unique: makes a retried creation idempotent. */
          create_operation_id: string | null
          deleted_at: string | null
          id: string
          is_active: boolean
          last_synced_at: string | null
          last_verified_at: string | null
          mode: Database["public"]["Enums"]["account_mode"]
          nickname: string
          owner_id: string
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
        }
        Insert: {
          alpaca_account_number?: string | null
          alpaca_key_secret_id?: string | null
          alpaca_secret_secret_id?: string | null
          color?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          last_verified_at?: string | null
          mode: Database["public"]["Enums"]["account_mode"]
          nickname: string
          owner_id: string
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Update: {
          alpaca_account_number?: string | null
          alpaca_key_secret_id?: string | null
          alpaca_secret_secret_id?: string | null
          color?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          last_synced_at?: string | null
          last_verified_at?: string | null
          mode?: Database["public"]["Enums"]["account_mode"]
          nickname?: string
          owner_id?: string
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          account_id: string | null
          action: string
          actor_id: string | null
          created_at: string
          detail: Json | null
          id: number
        }
        Insert: {
          account_id?: string | null
          action: string
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: never
        }
        Update: {
          account_id?: string | null
          action?: string
          actor_id?: string | null
          created_at?: string
          detail?: Json | null
          id?: never
        }
        Relationships: []
      }
      backtest_runs: {
        Row: {
          created_at: string
          end_date: string | null
          generated_at: string
          id: string
          kind: Database["public"]["Enums"]["backtest_kind"]
          start_date: string | null
          storage_path: string
          summary: Json
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          generated_at: string
          id: string
          kind: Database["public"]["Enums"]["backtest_kind"]
          start_date?: string | null
          storage_path: string
          summary: Json
        }
        Update: {
          created_at?: string
          end_date?: string | null
          generated_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["backtest_kind"]
          start_date?: string | null
          storage_path?: string
          summary?: Json
        }
        Relationships: []
      }
      cash_flows: {
        Row: {
          account_id: string
          amount: number
          created_at: string
          external_id: string | null
          flow_date: string
          id: number
          kind: string
          source: string
        }
        Insert: {
          account_id: string
          amount: number
          created_at?: string
          external_id?: string | null
          flow_date: string
          id?: never
          kind: string
          source?: string
        }
        Update: {
          account_id?: string
          amount?: number
          created_at?: string
          external_id?: string | null
          flow_date?: string
          id?: never
          kind?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_flows_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      equity_snapshots: {
        Row: {
          account_id: string
          cash: number
          created_at: string
          deposits: number
          equity: number
          id: number
          num_positions: number
          position_market_value: number
          profit_loss: number | null
          profit_loss_pct: number | null
          regime: string | null
          risk_tier: string | null
          snapshot_date: string
          source: string
          withdrawals: number
        }
        Insert: {
          account_id: string
          cash: number
          created_at?: string
          deposits?: number
          equity: number
          id?: never
          num_positions?: number
          position_market_value?: number
          profit_loss?: number | null
          profit_loss_pct?: number | null
          regime?: string | null
          risk_tier?: string | null
          snapshot_date: string
          source?: string
          withdrawals?: number
        }
        Update: {
          account_id?: string
          cash?: number
          created_at?: string
          deposits?: number
          equity?: number
          id?: never
          num_positions?: number
          position_market_value?: number
          profit_loss?: number | null
          profit_loss_pct?: number | null
          regime?: string | null
          risk_tier?: string | null
          snapshot_date?: string
          source?: string
          withdrawals?: number
        }
        Relationships: [
          {
            foreignKeyName: "equity_snapshots_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      market_history: {
        Row: {
          bar_date: string
          close: number
          symbol: string
        }
        Insert: {
          bar_date: string
          close: number
          symbol: string
        }
        Update: {
          bar_date?: string
          close?: number
          symbol?: string
        }
        Relationships: []
      }
      performance: {
        Row: {
          account_id: string
          all_time_twr_pct: number | null
          cash: number
          cash_pct: number
          daily_pnl: number
          daily_pnl_pct: number
          equity: number
          monthly_twr_pct: number | null
          num_positions: number
          position_value: number
          risk_tier: string
          risk_tier_reason: string | null
          updated_at: string
          weekly_twr_pct: number | null
          ytd_twr_pct: number | null
        }
        Insert: {
          account_id: string
          all_time_twr_pct?: number | null
          cash: number
          cash_pct: number
          daily_pnl?: number
          daily_pnl_pct?: number
          equity: number
          monthly_twr_pct?: number | null
          num_positions?: number
          position_value?: number
          risk_tier?: string
          risk_tier_reason?: string | null
          updated_at?: string
          weekly_twr_pct?: number | null
          ytd_twr_pct?: number | null
        }
        Update: {
          account_id?: string
          all_time_twr_pct?: number | null
          cash?: number
          cash_pct?: number
          daily_pnl?: number
          daily_pnl_pct?: number
          equity?: number
          monthly_twr_pct?: number | null
          num_positions?: number
          position_value?: number
          risk_tier?: string
          risk_tier_reason?: string | null
          updated_at?: string
          weekly_twr_pct?: number | null
          ytd_twr_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "performance_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: true
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      positions: {
        Row: {
          account_id: string
          avg_entry_price: number
          cost_basis: number | null
          current_price: number
          entry_date: string | null
          id: number
          market_value: number
          qty: number
          side: Database["public"]["Enums"]["trade_side_position"]
          strategy: string | null
          symbol: string
          unrealized_pl: number
          unrealized_pl_pct: number
          updated_at: string
        }
        Insert: {
          account_id: string
          avg_entry_price: number
          cost_basis?: number | null
          current_price: number
          entry_date?: string | null
          id?: never
          market_value: number
          qty: number
          side?: Database["public"]["Enums"]["trade_side_position"]
          strategy?: string | null
          symbol: string
          unrealized_pl: number
          unrealized_pl_pct: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          avg_entry_price?: number
          cost_basis?: number | null
          current_price?: number
          entry_date?: string | null
          id?: never
          market_value?: number
          qty?: number
          side?: Database["public"]["Enums"]["trade_side_position"]
          strategy?: string | null
          symbol?: string
          unrealized_pl?: number
          unrealized_pl_pct?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "positions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          default_account_id: string | null
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_account_id?: string | null
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_account_id?: string | null
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_account_fk"
            columns: ["default_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      research_snapshots: {
        Row: {
          buy_count: number | null
          created_at: string
          generated_at: string
          hold_count: number | null
          id: number
          sell_count: number | null
          spy: Json | null
          storage_path: string
          symbol_count: number | null
        }
        Insert: {
          buy_count?: number | null
          created_at?: string
          generated_at: string
          hold_count?: number | null
          id?: never
          sell_count?: number | null
          spy?: Json | null
          storage_path: string
          symbol_count?: number | null
        }
        Update: {
          buy_count?: number | null
          created_at?: string
          generated_at?: string
          hold_count?: number | null
          id?: never
          sell_count?: number | null
          spy?: Json | null
          storage_path?: string
          symbol_count?: number | null
        }
        Relationships: []
      }
      routine_runs: {
        Row: {
          account_id: string | null
          created_at: string
          duration_ms: number | null
          finished_at: string | null
          github_run_url: string | null
          id: number
          kind: Database["public"]["Enums"]["routine_kind"]
          started_at: string
          status: Database["public"]["Enums"]["routine_status"]
          summary: Json | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          duration_ms?: number | null
          finished_at?: string | null
          github_run_url?: string | null
          id?: never
          kind: Database["public"]["Enums"]["routine_kind"]
          started_at: string
          status: Database["public"]["Enums"]["routine_status"]
          summary?: Json | null
        }
        Update: {
          account_id?: string | null
          created_at?: string
          duration_ms?: number | null
          finished_at?: string | null
          github_run_url?: string | null
          id?: never
          kind?: Database["public"]["Enums"]["routine_kind"]
          started_at?: string
          status?: Database["public"]["Enums"]["routine_status"]
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "routine_runs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      screener_snapshots: {
        Row: {
          candidate_count: number | null
          created_at: string
          generated_at: string
          highest_score: number | null
          id: number
          scored_count: number | null
          storage_path: string
        }
        Insert: {
          candidate_count?: number | null
          created_at?: string
          generated_at: string
          highest_score?: number | null
          id?: never
          scored_count?: number | null
          storage_path: string
        }
        Update: {
          candidate_count?: number | null
          created_at?: string
          generated_at?: string
          highest_score?: number | null
          id?: never
          scored_count?: number | null
          storage_path?: string
        }
        Relationships: []
      }
      strategy_params: {
        Row: {
          gate_score_min: number | null
          id: number
          max_cash_pct: number | null
          max_position_pct: number | null
          max_positions: number | null
          min_cash_pct: number | null
          raw: Json | null
          regime: string
          risk_per_trade_pct: number | null
          risk_tier: string
          score_threshold: number | null
          trailing_stop_pct: number | null
          updated_at: string
        }
        Insert: {
          gate_score_min?: number | null
          id?: number
          max_cash_pct?: number | null
          max_position_pct?: number | null
          max_positions?: number | null
          min_cash_pct?: number | null
          raw?: Json | null
          regime: string
          risk_per_trade_pct?: number | null
          risk_tier: string
          score_threshold?: number | null
          trailing_stop_pct?: number | null
          updated_at?: string
        }
        Update: {
          gate_score_min?: number | null
          id?: number
          max_cash_pct?: number | null
          max_position_pct?: number | null
          max_positions?: number | null
          min_cash_pct?: number | null
          raw?: Json | null
          regime?: string
          risk_per_trade_pct?: number | null
          risk_tier?: string
          score_threshold?: number | null
          trailing_stop_pct?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      trades: {
        Row: {
          account_id: string
          alpaca_order_id: string | null
          created_at: string
          filled_at: string
          id: number
          notional: number
          price: number
          qty: number
          realized_pnl: number | null
          realized_pnl_pct: number | null
          reason: string | null
          side: Database["public"]["Enums"]["trade_side"]
          strategy: string | null
          symbol: string
        }
        Insert: {
          account_id: string
          alpaca_order_id?: string | null
          created_at?: string
          filled_at: string
          id?: never
          notional: number
          price: number
          qty: number
          realized_pnl?: number | null
          realized_pnl_pct?: number | null
          reason?: string | null
          side: Database["public"]["Enums"]["trade_side"]
          strategy?: string | null
          symbol: string
        }
        Update: {
          account_id?: string
          alpaca_order_id?: string | null
          created_at?: string
          filled_at?: string
          id?: never
          notional?: number
          price?: number
          qty?: number
          realized_pnl?: number | null
          realized_pnl_pct?: number | null
          reason?: string | null
          side?: Database["public"]["Enums"]["trade_side"]
          strategy?: string | null
          symbol?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_account_credentials: {
        Args: { acct: string }
        Returns: {
          api_key: string
          api_secret: string
        }[]
      }
      owns_account: { Args: { acct: string }; Returns: boolean }
      account_history_row_limit: { Args: Record<string, never>; Returns: number }
      account_history_snapshot: {
        Args: { p_account: string; p_owner: string; p_from?: string | null }
        Returns: Json
      }
      reconcile_cash_flow_mirror: {
        Args: {
          p_account: string
          p_owner: string
          p_from: string
          p_rows: Json
        }
        Returns: Json
      }
      replace_equity_snapshots: {
        Args: { p_account: string; p_owner: string; p_rows: Json }
        Returns: Json
      }
      begin_broker_refresh: {
        Args: { p_account: string; p_owner: string }
        /** `{ token, generation, credential_version, mode, account_number }` */
        Returns: Json
      }
      begin_broker_refresh_with_credentials: {
        Args: { p_account: string; p_owner: string }
        /**
         * The same reservation plus `api_key` and `api_secret`, read inside
         * the transaction that writes the token so the two cannot disagree.
         */
        Returns: Json
      }
      publish_broker_refresh: {
        Args: {
          p_token: string
          p_equity: Json
          p_equity_complete: boolean
          p_flows: Json
          p_flows_from: string
          p_flows_complete: boolean
          p_flows_scanned: number
          p_flows_saw_empty_page: boolean
        }
        Returns: Json
      }
      retract_equity_snapshot: {
        Args: {
          p_account: string
          p_owner: string
          p_date: string
          p_reason: string
        }
        Returns: boolean
      }
      retract_cash_flow: {
        Args: {
          p_account: string
          p_owner: string
          p_external_id: string
          p_reason: string
        }
        Returns: boolean
      }
      create_account_operation: {
        Args: {
          p_owner: string
          p_operation_id: string
          p_fingerprint: string
          p_nickname: string
          p_mode: Database["public"]["Enums"]["account_mode"]
          p_color: string
          p_api_key: string
          p_api_secret: string
          p_account_number: string
        }
        Returns: Database["public"]["Tables"]["accounts"]["Row"]
      }
      resolve_create_operation: {
        /**
         * The fingerprint is mandatory (0022). Matching the operation id alone
         * reported *some* account this owner created earlier as the thing just
         * created; a mismatch is now an explicit `conflict`.
         */
        Args: { p_owner: string; p_operation_id: string; p_fingerprint: string }
        /** `{ outcome: "created" | "absent" | "no_account" | "conflict", account_id? }` */
        Returns: Json
      }
      begin_account_verification: {
        Args: { p_account: string; p_owner: string }
        /**
         * `{ token, generation, expires_at, mode, credential_version,
         *    account_number, api_key, api_secret }`
         */
        Returns: Json
      }
      cancel_account_verification: {
        /**
         * Closes a token that concluded nothing — a network error, a timeout,
         * a 5xx or an unreadable body. Not a status write: nothing was learned
         * about the credentials, so nothing is recorded about them.
         */
        Args: {
          p_token: string
          p_reason:
            | "network_error"
            | "timeout"
            | "broker_unavailable"
            | "malformed_response"
            | "abandoned"
        }
        Returns: boolean
      }
      finish_account_verification: {
        Args: {
          p_token: string
          p_status: Database["public"]["Enums"]["account_status"]
          p_account_number?: string | null
        }
        Returns: Database["public"]["Tables"]["accounts"]["Row"]
      }
      find_account_by_operation: {
        Args: { p_owner: string; p_operation_id: string }
        Returns: Database["public"]["Tables"]["accounts"]["Row"]
      }
      purge_unassigned_credential_pair: {
        Args: {
          p_key: string
          p_secret: string
          p_owner: string
          /** A closed reason code (0022): the reason lands in an owner-readable audit row. */
          p_reason:
            | "orphaned_after_failed_create"
            | "orphaned_after_failed_rotation"
            | "operator_cleanup"
            | "integrity_repair"
        }
        Returns: number
      }
      update_account_metadata: {
        Args: {
          p_account: string
          p_owner: string
          p_nickname?: string | null
          p_color?: string | null
          p_is_active?: boolean | null
        }
        Returns: Database["public"]["Tables"]["accounts"]["Row"]
      }
      delete_account_atomic: {
        Args: { p_account: string; p_owner: string; p_purge_history?: boolean }
        Returns: boolean
      }
      rotate_account_credentials: {
        Args: {
          p_account: string
          p_owner: string
          p_api_key: string
          p_api_secret: string
          p_account_number: string
        }
        Returns: Database["public"]["Tables"]["accounts"]["Row"]
      }
    }
    Enums: {
      account_mode: "paper" | "live"
      account_status: "unverified" | "connected" | "auth_failed" | "paused"
      backtest_kind:
        | "single"
        | "sweep"
        | "monte_carlo"
        | "walk_forward"
        | "compare"
      routine_kind:
        | "premarket"
        | "execution"
        | "midday"
        | "eod"
        | "weekly"
        | "gap_scanner"
        | "backtest"
        | "auto_iteration"
        | "heartbeat"
      routine_status: "success" | "partial" | "failed" | "running"
      trade_side: "buy" | "sell"
      trade_side_position: "long" | "short"
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
      account_mode: ["paper", "live"],
      account_status: ["unverified", "connected", "auth_failed", "paused"],
      backtest_kind: [
        "single",
        "sweep",
        "monte_carlo",
        "walk_forward",
        "compare",
      ],
      routine_kind: [
        "premarket",
        "execution",
        "midday",
        "eod",
        "weekly",
        "gap_scanner",
        "backtest",
        "auto_iteration",
        "heartbeat",
      ],
      routine_status: ["success", "partial", "failed", "running"],
      trade_side: ["buy", "sell"],
      trade_side_position: ["long", "short"],
    },
  },
} as const
