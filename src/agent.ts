import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import type { GhlClient, GhlContact } from "./ghl";
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
    name: "escalate_to_human",
    description:
      "Hands the conversation to the team and stops automatic replies for this contact. Use for: price negotiation outside what was quoted, upset customers or complaints, requests for a person, cancel/reschedule requests, or technical questions the pricing reference can't answer.",
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

  const now = new Date();
  const userPrompt = [
    `Current date and time: ${formatInZone(now, env.TIMEZONE)} (${env.TIMEZONE}). Today is ${isoDateInZone(now, env.TIMEZONE)}.`,
    `Channel: ${ctx.channel === "SMS" ? "SMS text message" : "Instagram DM"}`,
    ctx.contact ? `Customer name on file: ${contactName(ctx.contact) || "unknown"}` : "",
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

      case "mark_buying_intent": {
        actions.push(`buying intent: ${String(input.summary)}`);
        if (ctx.contact) {
          await ctx.ghl.addTags(ctx.contact.id, [env.BUYING_INTENT_TAG]);
          await ctx.ghl.addNote(ctx.contact.id, `AI agent: buying intent. ${String(input.summary)}`);
        }
        return "Lead flagged for the team. Continue with booking.";
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
      return { actions, usage };
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: cleanReply(text), actions, usage };
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
  return { actions, usage };
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
