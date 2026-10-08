// Activity log for the dashboard: one SQLite-backed Durable Object holds every
// event the agent produces (messages in, replies, bookings, deposits, skips, errors).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type EventKind =
  | "message_in"
  | "reply"
  | "skip"
  | "error"
  | "buying_intent"
  | "deposit_link"
  | "deposit_paid"
  | "booking"
  | "rescheduled"
  | "cancelled"
  | "escalated"
  | "phone_saved"
  | "follow_up"
  | "follow_up_stopped";

export interface AgentEvent {
  id?: number;
  ts: number;
  contactId: string;
  contactName: string;
  channel: string;
  kind: EventKind;
  summary: string;
  ms?: number | null;
  calls?: number | null;
  costUsd?: number | null;
  amountCents?: number | null;
}

const RETENTION_DAYS = 120;

export class EventLog extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      contact_id TEXT NOT NULL,
      contact_name TEXT,
      channel TEXT,
      kind TEXT NOT NULL,
      summary TEXT,
      ms INTEGER,
      calls INTEGER,
      cost_usd REAL,
      amount_cents INTEGER
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_ts ON events(ts)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS events_contact ON events(contact_id, ts)");
  }

  async add(events: AgentEvent[]): Promise<void> {
    for (const e of events) {
      this.ctx.storage.sql.exec(
        "INSERT INTO events (ts, contact_id, contact_name, channel, kind, summary, ms, calls, cost_usd, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        e.ts,
        e.contactId,
        e.contactName,
        e.channel,
        e.kind,
        e.summary.slice(0, 2000),
        e.ms ?? null,
        e.calls ?? null,
        e.costUsd ?? null,
        e.amountCents ?? null,
      );
    }
    if (Math.random() < 0.02) {
      this.ctx.storage.sql.exec("DELETE FROM events WHERE ts < ?", Date.now() - RETENTION_DAYS * 86400_000);
    }
  }

  async list(opts: { afterId?: number; contactId?: string; limit?: number }): Promise<AgentEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = opts.contactId
      ? this.ctx.storage.sql.exec(
          "SELECT * FROM events WHERE id > ? AND contact_id = ? ORDER BY id DESC LIMIT ?",
          opts.afterId ?? 0,
          opts.contactId,
          limit,
        )
      : this.ctx.storage.sql.exec("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?", opts.afterId ?? 0, limit);
    return rows.toArray().map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      contactId: r.contact_id as string,
      contactName: (r.contact_name as string) ?? "",
      channel: (r.channel as string) ?? "",
      kind: r.kind as EventKind,
      summary: (r.summary as string) ?? "",
      ms: r.ms as number | null,
      calls: r.calls as number | null,
      costUsd: r.cost_usd as number | null,
      amountCents: r.amount_cents as number | null,
    }));
  }

  /** Totals since `sinceTs`: counts per kind, contacts, spend, deposits and reply speed. */
  async stats(sinceTs: number) {
    const byKind: Record<string, number> = {};
    for (const r of this.ctx.storage.sql.exec("SELECT kind, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY kind", sinceTs)) {
      byKind[r.kind as string] = r.n as number;
    }
    const agg = this.ctx.storage.sql
      .exec(
        `SELECT
           COUNT(DISTINCT contact_id) AS contacts,
           COALESCE(SUM(cost_usd), 0) AS cost,
           COALESCE(SUM(CASE WHEN kind = 'deposit_paid' THEN amount_cents END), 0) AS deposits_cents,
           AVG(CASE WHEN kind = 'reply' THEN ms END) AS avg_reply_ms
         FROM events WHERE ts >= ?`,
        sinceTs,
      )
      .one();
    return {
      byKind,
      contacts: agg.contacts as number,
      costUsd: agg.cost as number,
      depositsCents: agg.deposits_cents as number,
      avgReplyMs: (agg.avg_reply_ms as number | null) ?? null,
    };
  }
}

export function eventLog(env: Env) {
  return env.EVENTS.get(env.EVENTS.idFromName("global"));
}

/** Writes events without letting a logging failure break the agent. */
export async function record(env: Env, events: AgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await eventLog(env).add(events);
  } catch (err) {
    console.error("event log write failed", err);
  }
}

/** Maps the agent's action strings to dashboard events. */
export function actionKind(action: string): EventKind | undefined {
  if (action.startsWith("booked ")) return "booking";
  if (action.startsWith("deposit link ")) return "deposit_link";
  if (action.startsWith("buying intent")) return "buying_intent";
  if (action.startsWith("escalated")) return "escalated";
  if (action.startsWith("cancelled ")) return "cancelled";
  if (action.startsWith("rescheduled ")) return "rescheduled";
  if (action.startsWith("saved phone")) return "phone_saved";
  if (action.startsWith("follow-ups stopped")) return "follow_up_stopped";
  return undefined;
}

// USD per million tokens. Estimates for the dashboard only.
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function estimateCost(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return (
    (usage.input * p.input + usage.cacheWrite * p.input * 1.25 + usage.cacheRead * p.cacheRead + usage.output * p.output) /
    1_000_000
  );
}
