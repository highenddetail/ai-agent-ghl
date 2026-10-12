// Deposit-first booking: the customer picks a slot, pays the deposit link, and
// the appointment is created when Square reports the payment.

import type { Env } from "./env";
import type { GhlClient, GhlContact } from "./ghl";
import type { BookingCalendar } from "./knowledge";

export interface DepositSlot {
  calendarId: string;
  startTime: string; // ISO with offset, copied from get_available_slots
  notes: string;
}

export interface PendingDeposit {
  slots: DepositSlot[];
  amountCents: number;
  totalCents: number;
  url: string;
  orderId: string;
  channel: "SMS" | "IG";
  language: "en" | "es";
  createdAt: string;
}

/** A paid deposit whose appointment still has to be booked (the slot was taken while paying). */
export interface PaidCredit {
  amountCents: number;
  paymentId: string;
  services: string;
  at: string;
}

export interface DepositState {
  pending?: PendingDeposit;
  credit?: PaidCredit;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function formatWhen(iso: string, timeZone: string, language: "en" | "es"): string {
  return new Date(iso).toLocaleString(language === "es" ? "es-US" : "en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function addMinutesKeepingOffset(iso: string, minutes: number): string {
  const ms = Date.parse(iso) + minutes * 60_000;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return new Date(ms).toISOString();
  const offsetMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 19) + m[0];
}

export async function slotsForRange(
  ghl: GhlClient,
  calendarId: string,
  startDate: string,
  days: number,
  timezone: string,
): Promise<Record<string, string[]>> {
  // Query a padded UTC window, then keep only the requested local dates.
  const startMs = Date.parse(`${startDate}T00:00:00Z`) - 12 * 3600_000;
  const endMs = startMs + (days + 1) * 24 * 3600_000;
  const lastDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + (days - 1) * 24 * 3600_000).toISOString().slice(0, 10);
  const raw = await ghl.getFreeSlots(calendarId, startMs, endMs, timezone);
  const out: Record<string, string[]> = {};
  for (const day of Object.keys(raw).sort()) {
    if (day >= startDate && day <= lastDate && raw[day].slots.length > 0) out[day] = raw[day].slots;
  }
  return out;
}

export async function isSlotOpen(ghl: GhlClient, calendarId: string, startTime: string, timezone: string): Promise<boolean> {
  const day = startTime.slice(0, 10);
  const open = await slotsForRange(ghl, calendarId, day, 1, timezone);
  return (open[day] ?? []).some((s) => Date.parse(s) === Date.parse(startTime));
}

export type BookResult = { ok: true; id: string; startTime: string; endTime: string } | { ok: false; reason: string };

/** Creates one GHL appointment after re-checking the slot is still free. */
export async function bookSlot(
  ghl: GhlClient,
  env: Env,
  contact: GhlContact,
  calendar: BookingCalendar,
  startTime: string,
  description: string,
): Promise<BookResult> {
  if (!(await isSlotOpen(ghl, calendar.id, startTime, env.TIMEZONE))) {
    return { ok: false, reason: "that time is no longer available" };
  }
  const endTime = addMinutesKeepingOffset(startTime, calendar.durationMinutes);
  const name = contactDisplayName(contact) || "Customer";
  const appointment = await ghl.createAppointment({
    calendarId: calendar.id,
    contactId: contact.id,
    startTime,
    endTime,
    assignedUserId: calendar.userId,
    title: `${name} - ${calendar.name}`,
    description,
  });
  await ghl
    .addNote(contact.id, `AI agent booked: ${calendar.name}, ${startTime}. ${description}`)
    .catch((e) => console.error("addNote failed", e));
  if (isOvernightService(calendar) && calendar.userId) {
    await blockOvernightTime(ghl, calendar.userId, `${name} - ${calendar.name}`, endTime, env.TIMEZONE).catch((e) =>
      console.error("blockOvernightTime failed", e),
    );
  }
  return { ok: true, id: appointment.id, startTime, endTime };
}

/** Full Front End PPF takes about 1.5 days: drop off in the morning, pick up the next business day afternoon. */
export function isOvernightService(calendar: { name: string }): boolean {
  return /^Full Front End PPF\b/i.test(calendar.name);
}

const CLOSE_HOUR = { weekday: "17:00", saturday: "15:00" };

/**
 * Blocks the rest of the drop-off day after the appointment ends, and the next business
 * morning (closed Sundays), so nothing else gets booked while the car is still in the shop.
 */
async function blockOvernightTime(ghl: GhlClient, userId: string, title: string, endTime: string, timeZone: string) {
  const day = endTime.slice(0, 10);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const close = zonedIso(day, weekday === 6 ? CLOSE_HOUR.saturday : CLOSE_HOUR.weekday, timeZone);
  if (Date.parse(close) > Date.parse(endTime)) {
    await ghl.createBlockSlot({ assignedUserId: userId, startTime: endTime, endTime: close, title: `${title} (car in shop)` });
  }
  let next = new Date(`${day}T12:00:00Z`);
  do next = new Date(next.getTime() + 86_400_000);
  while (next.getUTCDay() === 0);
  const nextDay = next.toISOString().slice(0, 10);
  await ghl.createBlockSlot({
    assignedUserId: userId,
    startTime: zonedIso(nextDay, "09:00", timeZone),
    endTime: zonedIso(nextDay, "13:00", timeZone),
    title: `${title} (day 2)`,
  });
}

/** "2026-10-26" + "09:00" in America/New_York -> "2026-10-26T09:00:00-04:00" (DST-aware). */
export function zonedIso(day: string, hhmm: string, timeZone: string): string {
  const probe = new Date(`${day}T${hhmm}:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name ?? "");
  const offset = m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
  return `${day}T${hhmm}:00${offset}`;
}

export function contactDisplayName(c: GhlContact): string {
  return c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ");
}
