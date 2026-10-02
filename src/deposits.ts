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
  return { ok: true, id: appointment.id, startTime, endTime };
}

export function contactDisplayName(c: GhlContact): string {
  return c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ");
}
