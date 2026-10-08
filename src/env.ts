export interface Env {
  CONVERSATIONS: DurableObjectNamespace<import("./index").ConversationAgent>;
  EVENTS: DurableObjectNamespace<import("./events").EventLog>;

  ANTHROPIC_API_KEY: string;
  GHL_TOKEN: string;
  WEBHOOK_SECRET: string;
  SQUARE_ACCESS_TOKEN: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY: string;
  /** Optional: separate read-only key for the dashboard; falls back to WEBHOOK_SECRET. */
  DASHBOARD_KEY?: string;

  GHL_LOCATION_ID: string;
  TIMEZONE: string;
  CLAUDE_MODEL: string;
  CLAUDE_EFFORT: string;
  BOOKING_LINK: string;
  ONLY_TAG: string;
  DRY_RUN: string;
  STOP_TAGS: string;
  ESCALATION_TAG: string;
  BUYING_INTENT_TAG: string;
  DEBOUNCE_SECONDS: string;
  HUMAN_PAUSE_MINUTES: string;
  CHANGE_NOTICE_HOURS: string;
  SQUARE_LOCATION_ID: string;
  DEPOSIT_PERCENT: string;
  DEPOSIT_PENDING_TAG: string;
  DEPOSIT_PAID_TAG: string;
  /** "on" sends follow-ups, "draft" writes them as contact notes, "off" disables them. */
  FOLLOWUPS: string;
  /** Delays after Julia's unanswered message, e.g. "1h,1d,2d,7d,30d". */
  FOLLOWUP_SCHEDULE: string;
  /** Send window in shop time, "8-18" = 8 AM to 6 PM, Monday to Saturday. */
  FOLLOWUP_HOURS: string;
  /** Added when the customer asks not to be messaged again; no follow-ups while present. */
  FOLLOWUP_OPTOUT_TAG: string;
}

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
