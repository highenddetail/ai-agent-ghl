// Follow-ups: when a customer goes quiet after Julia's message, she writes again
// on a fixed cadence (FOLLOWUP_SCHEDULE), only inside the send window, and stops
// for good when they reply, book, pay, opt out, or the team takes over.

import type { Env } from "./env";

export interface FollowUpState {
  /** When Julia's unanswered message went out; the cadence counts from here. */
  anchorAt: number;
  /** Follow-ups already sent in this sequence. */
  sent: number;
  /** When the next one is due (already moved inside the send window). */
  dueAt: number;
  channel: "SMS" | "IG";
  lastSentAt?: number;
  /** Set when the customer asked to be contacted on a date ("next month"): one message then, then the normal cadence. */
  deferred?: string;
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 };
/** Never two follow-ups closer than this, even when the window pushes one back. */
const MIN_GAP_MS = 12 * 3600_000;

/** "1h,1d,2d,7d,30d" -> offsets in ms from the unanswered message. */
export function followUpOffsets(env: Env): number[] {
  return (env.FOLLOWUP_SCHEDULE || "1h,1d,2d,7d,30d")
    .split(",")
    .map((s) => /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/i.exec(s))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
}

export function followUpMode(env: Env): "on" | "draft" | "off" {
  const mode = (env.FOLLOWUPS || "off").trim().toLowerCase();
  if (mode === "off") return "off";
  return mode === "on" && env.DRY_RUN !== "true" ? "on" : "draft";
}

/** First follow-up of a new sequence, counted from Julia's message that just went out. */
export function startSequence(env: Env, channel: "SMS" | "IG", anchorAt = Date.now()): FollowUpState | undefined {
  const offsets = followUpOffsets(env);
  if (offsets.length === 0) return undefined;
  return { anchorAt, sent: 0, channel, dueAt: nextSendTime(env, anchorAt + offsets[0]) };
}

/** One follow-up on the date the customer named, at the start of that day's window. */
export function deferredSequence(env: Env, channel: "SMS" | "IG", isoDate: string, reason: string): FollowUpState | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const [startHour] = windowHours(env);
  const at = Date.parse(wallToIso(`${isoDate}T${String(startHour + 2).padStart(2, "0")}:00:00`, env.TIMEZONE));
  if (Number.isNaN(at) || at < Date.now()) return undefined;
  return { anchorAt: Date.now(), sent: 0, channel, dueAt: nextSendTime(env, at), deferred: reason };
}

/** State after a follow-up went out, or undefined when the sequence is over. */
export function advance(env: Env, state: FollowUpState, now = Date.now()): FollowUpState | undefined {
  const offsets = followUpOffsets(env);
  // A deferred message restarts the regular cadence from it, skipping the 1-hour nudge.
  const next = state.deferred ? { ...state, anchorAt: now, sent: 1, deferred: undefined } : { ...state, sent: state.sent + 1 };
  if (next.sent >= offsets.length) return undefined;
  const due = Math.max(next.anchorAt + offsets[next.sent], now + MIN_GAP_MS);
  return { ...next, lastSentAt: now, dueAt: nextSendTime(env, due) };
}

function windowHours(env: Env): [number, number] {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(env.FOLLOWUP_HOURS || "8-18");
  return m ? [Number(m[1]), Number(m[2])] : [8, 18];
}

/** True when `ms` is Monday-Saturday between the window hours, shop time. Never Sundays. */
export function inSendWindow(env: Env, ms: number): boolean {
  const { weekday, hour } = wallParts(ms, env.TIMEZONE);
  const [start, end] = windowHours(env);
  return weekday !== 0 && hour >= start && hour < end;
}

/** `ms` if it's inside the send window, otherwise the next window opening (plus a few minutes, so it doesn't read automated). */
export function nextSendTime(env: Env, ms: number): number {
  if (inSendWindow(env, ms)) return ms;
  const [start] = windowHours(env);
  let { date, hour } = wallParts(ms, env.TIMEZONE);
  if (hour >= start) date = addDays(date, 1);
  for (let i = 0; i < 8; i++) {
    const open = Date.parse(wallToIso(`${date}T${String(start).padStart(2, "0")}:00:00`, env.TIMEZONE));
    if (inSendWindow(env, open)) return open + Math.floor(Math.random() * 25 + 5) * 60_000;
    date = addDays(date, 1);
  }
  return ms;
}

function wallParts(ms: number, timeZone: string): { date: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday, hour: Number(parts.hour) };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-03T08:00:00" (wall time in timeZone) -> ISO with that zone's offset on that date. */
function wallToIso(wall: string, timeZone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(new Date(`${wall}Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  return `${wall}${m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00"}`;
}

/** Whole-message opt-out keywords (carrier STOP words, English and Spanish). */
export function isOptOutKeyword(body: string): boolean {
  return /^\s*(stop|stopall|unsubscribe|end|quit|baja|detener)\s*[.!]*\s*$/i.test(body);
}

export function describeSilence(ms: number): string {
  const h = Math.round(ms / 3600_000);
  if (h < 1) return "less than an hour";
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.round(h / 24)} days`;
}
