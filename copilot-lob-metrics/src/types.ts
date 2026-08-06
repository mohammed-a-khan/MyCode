/**
 * Shapes returned by the GitHub Copilot Metrics API.
 * Fields are optional/nullable because GitHub omits sections with no activity.
 * https://docs.github.com/en/rest/copilot/copilot-metrics
 */

export interface LanguageMetrics {
  name: string;
  total_engaged_users?: number;
  total_code_suggestions?: number;
  total_code_acceptances?: number;
  total_code_lines_suggested?: number;
  total_code_lines_accepted?: number;
}

export interface ModelMetrics {
  name: string;
  is_custom_model?: boolean;
  total_engaged_users?: number;
  languages?: LanguageMetrics[];
  // chat models
  total_chats?: number;
  total_chat_insertion_events?: number;
  total_chat_copy_events?: number;
  // PR models
  total_pr_summaries_created?: number;
}

export interface EditorMetrics {
  name: string;
  total_engaged_users?: number;
  models?: ModelMetrics[];
}

export interface CopilotDayMetrics {
  date: string;
  total_active_users?: number;
  total_engaged_users?: number;
  copilot_ide_code_completions?: {
    total_engaged_users?: number;
    languages?: LanguageMetrics[];
    editors?: EditorMetrics[];
  } | null;
  copilot_ide_chat?: {
    total_engaged_users?: number;
    editors?: EditorMetrics[];
  } | null;
  copilot_dotcom_chat?: {
    total_engaged_users?: number;
    models?: ModelMetrics[];
  } | null;
  copilot_dotcom_pull_requests?: {
    total_engaged_users?: number;
    repositories?: { name: string; total_engaged_users?: number; models?: ModelMetrics[] }[];
  } | null;
}
