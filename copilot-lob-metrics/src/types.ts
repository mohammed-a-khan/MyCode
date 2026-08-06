/**
 * Shapes for the GitHub Copilot usage metrics APIs (current as of 2026).
 *
 * The REST endpoints under /orgs/{org}/copilot/metrics/reports/* return an
 * envelope with signed download links; the actual rows are newline-delimited
 * JSON (NDJSON) files downloaded from those links.
 *
 * References:
 * - https://docs.github.com/en/rest/copilot/copilot-usage-metrics
 * - https://docs.github.com/en/copilot/reference/copilot-usage-metrics
 * - https://docs.github.com/en/copilot/reference/copilot-usage-metrics/team-level-metrics
 */

/** Envelope returned by every reports endpoint. */
export interface ReportEnvelope {
  download_links: string[];
  report_day?: string;
}

/** Shared counter fields used at top level and inside totals_by_* entries. */
export interface ActivityCounters {
  user_initiated_interaction_count?: number;
  code_generation_activity_count?: number;
  code_acceptance_activity_count?: number;
  loc_suggested_to_add_sum?: number;
  loc_suggested_to_delete_sum?: number;
  loc_added_sum?: number;
  loc_deleted_sum?: number;
}

/** Entry in totals_by_language_feature[] / totals_by_model_feature[] etc. */
export interface BreakdownEntry extends ActivityCounters {
  language?: string;
  feature?: string;
  model?: string;
  ide?: string;
}

/** One row of the per-user usage report (organization_users_1_day). */
export interface UserUsageRow extends ActivityCounters {
  user_id: number;
  user_login: string;
  day: string;
  organization_id?: string;
  enterprise_id?: string;
  ai_credits_used?: number;
  used_chat?: boolean;
  used_agent?: boolean;
  used_cli?: boolean;
  used_copilot_cloud_agent?: boolean;
  used_copilot_code_review_active?: boolean | null;
  ai_adoption_phase?: { phase_number: number; phase: string; version?: string };
  totals_by_ide?: BreakdownEntry[];
  totals_by_feature?: BreakdownEntry[];
  totals_by_language_feature?: BreakdownEntry[];
  totals_by_language_model?: BreakdownEntry[];
  totals_by_model_feature?: BreakdownEntry[];
}

/** One row of the user-teams report (organization_user_teams_1_day). */
export interface UserTeamRow {
  user_id: number;
  user_login: string;
  day: string;
  organization_id?: string;
  enterprise_id?: string;
  team_id: number;
  slug: string;
}

/** One row of the aggregated organization report (organization_1_day). */
export interface OrgAggregateRow extends ActivityCounters {
  day: string;
  organization_id?: string;
  enterprise_id?: string;
  daily_active_users?: number;
  weekly_active_users?: number;
  monthly_active_users?: number;
  monthly_active_chat_users?: number;
  monthly_active_agent_users?: number;
  totals_by_language_feature?: BreakdownEntry[];
  totals_by_ide?: BreakdownEntry[];
  pull_requests?: {
    total_created?: number;
    total_merged?: number;
    total_created_by_copilot?: number;
    total_reviewed_by_copilot?: number;
    median_minutes_to_merge?: number | null;
  };
}
