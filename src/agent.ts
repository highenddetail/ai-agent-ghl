import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { GhlAppointment, GhlClient, GhlContact } from "./ghl";
import { getCalendar, getPricing, searchCalendars } from "./knowledge";
import { buildSystemPrompt } from "./prompt";

const MAX_TURNS = 10;
// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface AgentContext {
  env: Env;
  ghl: GhlClient;
  /** Undefined in simulation: tools that write to GHL become no-ops. */
  contact?: GhlContact;
  channel: "SMS" | "IG";
  /** Conversation rendered as plain text, oldest first. */
  transcript: string;
}

export interface AgentResult {
  /** Text to send, or undefined when the agent decided not to reply. */
  reply?: string;
  actions: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Model calls made for this reply (1 + one per tool round). */
  rounds: number;
}

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_pricing",
    description:
      "Returns the official High End Detail price list and 'what's included' descriptions for one service category. Call this before quoting any price, package name, duration, or service details.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Exact category name from the list in the system prompt." },
      },
      required: ["category"],
      additionalProperties: false,
    },
  },
  {
    name: "find_booking_calendar",
    description:
      "Searches the shop's booking calendars (one per service and vehicle type) by keywords that must all appear in the calendar name. Returns matching calendar ids and names.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: 'Case-insensitive keywords, e.g. ["pinnacle", "sedan"] or ["tesla model 3", "full front"].',
        },
      },
      required: ["keywords"],
      additionalProperties: false,
    },
  },
  {
    name: "get_available_slots",
    description:
      "Returns open appointment start times (Eastern Time) for a booking calendar, starting on a given date. Only offer customers times returned by this tool.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        start_date: { type: "string", description: "First day to check, YYYY-MM-DD." },
        days: { type: "integer", description: "How many days to check, 1-7." },
      },
      required: ["calendar_id", "start_date", "days"],
      additionalProperties: false,
    },
  },
  {
    name: "book_appointment",
    description:
      "Books the customer into a calendar slot. Only call after the customer explicitly confirmed this exact date and time. start_time must be copied exactly from get_available_slots.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        start_time: { type: "string", description: "ISO 8601 with offset, e.g. 2026-10-03T09:45:00-04:00." },
        notes: { type: "string", description: "Vehicle and job details for the team, e.g. '2022 Toyota Corolla, Stratos windshield'." },
      },
      required: ["calendar_id", "start_time", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "save_contact_phone",
    description:
      "Saves the customer's mobile phone number to their contact record. Use on Instagram when the customer gives their number. Returns the normalized number, or an error if it doesn't look like a valid phone number.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number exactly as the customer wrote it." },
      },
      required: ["phone"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_buying_intent",
    description:
      "Flags the lead for the team. Call when the customer clearly expresses intent to move forward with a service: agreeing to proceed, asking how to pay, asking when they can bring their vehicle in, confirming they want to book, or similar clear buying signals. Do not call on price questions alone, only on actual intent to advance.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line: vehicle, service and option the customer wants, and price quoted." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "list_appointments",
    description:
      "Lists the customer's upcoming appointments (id, service, start and end in Eastern Time). Call this before cancelling or rescheduling.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancels one of the customer's upcoming appointments. Only call after the customer explicitly confirmed they want to cancel that specific appointment.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "Id from list_appointments." },
        reason: { type: "string", description: "Short reason the customer gave, for the team." },
      },
      required: ["appointment_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Moves one of the customer's upcoming appointments to a new start time on the same service calendar, keeping its length. new_start_time must be copied exactly from get_available_slots for that appointment's calendar, and the customer must have confirmed it.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "Id from list_appointments." },
        new_start_time: { type: "string", description: "ISO 8601 with offset, e.g. 2026-10-05T10:30:00-04:00." },
      },
      required: ["appointment_id", "new_start_time"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hands the conversation to the team and stops automatic replies for this contact. Use for: price negotiation outside what was quoted, upset customers or complaints, requests for a person, or technical questions the pricing reference can't answer.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short explanation for the team." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
  const { env } = ctx;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.CLAUDE_MODEL || "claude-opus-5-5";
  const actions: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const bookedSlots = new Set<string>();

  let savedPhone = ctx.contact?.phone ?? "";
  const phoneOnFile = () => Boolean(savedPhone);

  const now = new Date();
  const userPrompt = [
    `Current date and time: ${formatInZone(now, env.TIMEZONE)} (${env.TIMEZONE}). Today is ${isoDateInZone(now, env.TIMEZONE)}.`,
    `Channel: ${ctx.channel === "SMS" ? "SMS text message" : "Instagram DM"}`,
    ctx.contact ? `Customer name on file: ${contactName(ctx.contact) || "unknown"}` : "",
    `Customer phone on file: ${phoneOnFile() ? "yes" : "no"}`,
    "",
    "<conversation>",
    ctx.transcript,
    "</conversation>",
    "",
    "Write Julia's next message to the customer (or NO_REPLY).",
  ].join("\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userPrompt }];

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "get_pricing":
        return getPricing(String(input.category));

      case "find_booking_calendar": {
        const matches = searchCalendars((input.keywords as string[]) ?? []);
        if (matches.length === 0) return "No calendars match. Try fewer or different keywords.";
        if (matches.length > 25) return `${matches.length} calendars match. Add more specific keywords.`;
        return JSON.stringify(matches.map((c) => ({ id: c.id, name: c.name, durationMinutes: c.durationMinutes })));
      }

      case "get_available_slots": {
        const calendar = getCalendar(String(input.calendar_id));
        if (!calendar) return "Unknown calendar_id. Use find_booking_calendar first.";
        const startDate = String(input.start_date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return "start_date must be YYYY-MM-DD.";
        const days = Math.min(Math.max(Number(input.days) || 1, 1), 7);
        const slots = await slotsForRange(ctx.ghl, calendar.id, startDate, days, env.TIMEZONE);
        const entries = Object.entries(slots);
        if (entries.length === 0) return "No open slots in that range.";
        return entries.map(([day, times]) => `${weekdayOf(day)} ${day}: ${times.slice(0, 8).join(", ")}`).join("\n");
      }

      case "book_appointment": {
        const calendar = getCalendar(String(input.calendar_id));
        if (!calendar) return "NOT BOOKED: unknown calendar_id. Use find_booking_calendar first.";
        const startTime = String(input.start_time);
        const startMs = Date.parse(startTime);
        if (Number.isNaN(startMs)) return "NOT BOOKED: start_time is not a valid ISO date.";
        const slotKey = `${calendar.id}|${startMs}`;
        if (bookedSlots.has(slotKey)) return "NOT BOOKED: this exact appointment was already booked in this reply. Do not book it twice.";
        if (bookedSlots.size >= 3) return "NOT BOOKED: too many bookings in one reply. Confirm with the customer first.";
        const day = startTime.slice(0, 10);
        const open = await slotsForRange(ctx.ghl, calendar.id, day, 1, env.TIMEZONE);
        if (!(open[day] ?? []).some((s) => Date.parse(s) === startMs)) {
          return "NOT BOOKED: that time is not available. Call get_available_slots again and offer other times.";
        }
        if (ctx.channel === "IG" && !phoneOnFile()) {
          return "NOT BOOKED: on Instagram you must get the customer's phone number first. Ask for it, save it with save_contact_phone, then book.";
        }
        const endTime = addMinutesKeepingOffset(startTime, calendar.durationMinutes);
        if (!ctx.contact) {
          bookedSlots.add(slotKey);
          actions.push(`[simulation] would book ${calendar.name} at ${startTime}`);
          return `Simulation mode: booking not created. Pretend it succeeded for ${calendar.name}, ${startTime} to ${endTime}.`;
        }
        const name = contactName(ctx.contact) || "Customer";
        const appointment = await ctx.ghl.createAppointment({
          calendarId: calendar.id,
          contactId: ctx.contact.id,
          startTime,
          endTime,
          assignedUserId: calendar.userId,
          title: `${name} - ${calendar.name}`,
          description: `Booked by AI agent (Julia) via ${ctx.channel}. ${String(input.notes ?? "")}`,
        });
        bookedSlots.add(slotKey);
        actions.push(`booked ${calendar.name} at ${startTime} (appointment ${appointment.id})`);
        await ctx.ghl
          .addNote(ctx.contact.id, `AI agent booked: ${calendar.name}, ${startTime}. ${String(input.notes ?? "")}`)
          .catch((e) => console.error("addNote failed", e));
        return `Booked. Appointment ${appointment.id}: ${calendar.name}, ${startTime} to ${endTime}.`;
      }

      case "save_contact_phone": {
        const phone = normalizePhone(String(input.phone));
        if (!phone) return "Not saved: that doesn't look like a valid phone number. Ask the customer to double-check it.";
        if (ctx.contact) await ctx.ghl.updateContact(ctx.contact.id, { phone });
        savedPhone = phone;
        actions.push(`saved phone ${phone}`);
        return `Saved ${phone}.`;
      }

      case "mark_buying_intent": {
        actions.push(`buying intent: ${String(input.summary)}`);
        if (ctx.contact) {
          await ctx.ghl.addTags(ctx.contact.id, [env.BUYING_INTENT_TAG]);
          await ctx.ghl.addNote(ctx.contact.id, `AI agent: buying intent. ${String(input.summary)}`);
        }
        return "Lead flagged for the team. Continue with booking.";
      }

      case "list_appointments": {
        if (!ctx.contact) return "Simulation mode: no appointments on file.";
        const upcoming = await upcomingAppointments(ctx.ghl, ctx.contact.id, env.TIMEZONE);
        if (upcoming.length === 0) return "The customer has no upcoming appointments.";
        return JSON.stringify(
          upcoming.map((a) => ({
            id: a.id,
            service: getCalendar(a.calendarId)?.name ?? a.title,
            calendar_id: a.calendarId,
            start: a.startIso,
            end: a.endIso,
            can_change_by_text: !withinNotice(a, env),
          })),
        );
      }

      case "cancel_appointment": {
        if (!ctx.contact) {
          actions.push(`[simulation] would cancel ${String(input.appointment_id)}`);
          return "Simulation mode: cancelled.";
        }
        const appt = (await upcomingAppointments(ctx.ghl, ctx.contact.id, env.TIMEZONE)).find(
          (a) => a.id === String(input.appointment_id),
        );
        if (!appt) return "NOT CANCELLED: that appointment id isn't one of this customer's upcoming appointments. Call list_appointments.";
        if (withinNotice(appt, env)) {
          return `NOT CANCELLED: this appointment starts in less than ${noticeHours(env)} hours, so it can't be changed by text under the shop's policy. Call escalate_to_human and tell the customer the team will contact them.`;
        }
        await ctx.ghl.updateAppointment(appt.id, { appointmentStatus: "cancelled" });
        const service = getCalendar(appt.calendarId)?.name ?? appt.title ?? "appointment";
        actions.push(`cancelled ${service} at ${appt.startIso}`);
        await ctx.ghl.addTags(ctx.contact.id, ["ai-cancelled"]).catch((e) => console.error("addTags failed", e));
        await ctx.ghl
          .addNote(ctx.contact.id, `AI agent cancelled: ${service}, ${appt.startIso}. Reason: ${String(input.reason)}`)
          .catch((e) => console.error("addNote failed", e));
        return `Cancelled ${service} on ${appt.startIso}.`;
      }

      case "reschedule_appointment": {
        const newStart = String(input.new_start_time);
        const newStartMs = Date.parse(newStart);
        if (Number.isNaN(newStartMs)) return "NOT RESCHEDULED: new_start_time is not a valid ISO date.";
        if (!ctx.contact) {
          actions.push(`[simulation] would move ${String(input.appointment_id)} to ${newStart}`);
          return `Simulation mode: rescheduled to ${newStart}.`;
        }
        const appt = (await upcomingAppointments(ctx.ghl, ctx.contact.id, env.TIMEZONE)).find(
          (a) => a.id === String(input.appointment_id),
        );
        if (!appt) return "NOT RESCHEDULED: that appointment id isn't one of this customer's upcoming appointments. Call list_appointments.";
        if (withinNotice(appt, env)) {
          return `NOT RESCHEDULED: this appointment starts in less than ${noticeHours(env)} hours, so it can't be changed by text under the shop's policy. Call escalate_to_human and tell the customer the team will contact them.`;
        }
        const day = newStart.slice(0, 10);
        const open = await slotsForRange(ctx.ghl, appt.calendarId, day, 1, env.TIMEZONE);
        if (!(open[day] ?? []).some((s) => Date.parse(s) === newStartMs)) {
          return "NOT RESCHEDULED: that time is not available on this service's calendar. Call get_available_slots with this appointment's calendar_id and offer other times.";
        }
        const lengthMin = Math.round((Date.parse(appt.endIso) - Date.parse(appt.startIso)) / 60_000);
        const newEnd = addMinutesKeepingOffset(newStart, lengthMin);
        await ctx.ghl.updateAppointment(appt.id, { calendarId: appt.calendarId, startTime: newStart, endTime: newEnd });
        const service = getCalendar(appt.calendarId)?.name ?? appt.title ?? "appointment";
        actions.push(`rescheduled ${service} from ${appt.startIso} to ${newStart}`);
        await ctx.ghl.addTags(ctx.contact.id, ["ai-rescheduled"]).catch((e) => console.error("addTags failed", e));
        await ctx.ghl
          .addNote(ctx.contact.id, `AI agent rescheduled ${service}: ${appt.startIso} -> ${newStart}`)
          .catch((e) => console.error("addNote failed", e));
        return `Rescheduled. ${service} moved to ${newStart} - ${newEnd}.`;
      }

      case "escalate_to_human": {
        actions.push(`escalated: ${String(input.reason)}`);
        if (ctx.contact) {
          await ctx.ghl.addTags(ctx.contact.id, [env.ESCALATION_TAG]);
          await ctx.ghl.addNote(ctx.contact.id, `AI agent escalated to a human: ${String(input.reason)}`);
        }
        return "The team has been notified and automatic replies are paused for this contact. Send one short message saying someone from the team will follow up shortly.";
      }

      default:
        return `Unknown tool ${name}`;
    }
  };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(env.BOOKING_LINK),
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages,
      output_config: { effort: (env.CLAUDE_EFFORT || "low") as Anthropic.Beta.BetaOutputConfig["effort"] },
    };
    if (FALLBACK_MODELS.has(model)) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }

    const response = await client.beta.messages.create(params);
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      actions.push("model refused");
      return { actions, usage, rounds: turn + 1 };
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: cleanReply(text), actions, usage, rounds: turn + 1 };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      try {
        const content = await executeTool(tool.name, tool.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: tool.id, content });
      } catch (err) {
        console.error(`tool ${tool.name} failed`, err);
        results.push({
          type: "tool_result",
          tool_use_id: tool.id,
          is_error: true,
          content: `${tool.name === "book_appointment" ? "NOT BOOKED. " : ""}Tool failed: ${err instanceof Error ? err.message : String(err)}. If this was a booking, do not tell the customer it is booked; send the booking link instead.`,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  actions.push("gave up after too many tool calls");
  return { actions, usage, rounds: MAX_TURNS };
}

/** US-first normalization to E.164; returns "" when it isn't a plausible number. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

function cleanReply(text: string): string | undefined {
  if (!text || /^NO_REPLY\b/.test(text)) return undefined;
  // House style: never long dashes in customer messages.
  return text.replace(/\s*—\s*/g, ", ").replace(/^["']|["']$/g, "").trim() || undefined;
}

export function contactName(c: GhlContact): string {
  return c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ");
}

async function slotsForRange(
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

function addMinutesKeepingOffset(iso: string, minutes: number): string {
  const ms = Date.parse(iso) + minutes * 60_000;
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) return new Date(ms).toISOString();
  const offsetMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 19) + m[0];
}

function noticeHours(env: Env): number {
  return Number(env.CHANGE_NOTICE_HOURS || "24");
}

/** Shop policy: changes need this much notice before the appointment starts. */
function withinNotice(appt: UpcomingAppointment, env: Env): boolean {
  return Date.parse(appt.startIso) - Date.now() < noticeHours(env) * 3600_000;
}

interface UpcomingAppointment extends GhlAppointment {
  startIso: string;
  endIso: string;
}

async function upcomingAppointments(ghl: GhlClient, contactId: string, timeZone: string): Promise<UpcomingAppointment[]> {
  const now = Date.now();
  return (await ghl.getContactAppointments(contactId))
    .filter((a) => !a.deleted && !/cancel/i.test(a.appointmentStatus ?? ""))
    .map((a) => ({ ...a, startIso: localToIso(a.startTime, timeZone), endIso: localToIso(a.endTime, timeZone) }))
    .filter((a) => Date.parse(a.startIso) > now)
    .sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
}

/** "2026-10-03 12:00:00" (wall time in timeZone) -> "2026-10-03T12:00:00-04:00". Already-ISO input passes through. */
function localToIso(local: string, timeZone: string): string {
  if (/[T].*([+-]\d{2}:\d{2}|Z)$/.test(local)) return local;
  const wall = local.replace(" ", "T").slice(0, 19);
  const guess = new Date(`${wall}Z`);
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(guess)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  const offset = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00";
  return `${wall}${offset}`;
}

function weekdayOf(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

export function formatInZone(d: Date, timeZone: string): string {
  return d.toLocaleString("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isoDateInZone(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-CA", { timeZone }); // en-CA formats as YYYY-MM-DD
}
