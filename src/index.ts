import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { contactName, formatInZone, runAgent } from "./agent";
import { csv, type Env } from "./env";
import { GhlClient, GhlError, type GhlMessage } from "./ghl";
import { CALENDARS } from "./knowledge";

const CHANNELS: Record<string, "SMS" | "IG"> = {
  TYPE_SMS: "SMS",
  TYPE_INSTAGRAM: "IG",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, service: "hed-ai-agent" });
    }

    if (!env.WEBHOOK_SECRET) return new Response("unauthorized: WEBHOOK_SECRET is not set in Cloudflare", { status: 401 });
    if (!authorized(url, request, env)) return new Response("unauthorized: key does not match WEBHOOK_SECRET", { status: 401 });

    // Open in a browser: /diag?key=...&contact=<GHL contact id>[&run=1]
    if (url.pathname === "/diag" && request.method === "GET") {
      return Response.json(await diagnose(env, url.searchParams.get("contact"), url.searchParams.get("run") === "1"), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/webhook/ghl" && request.method === "POST") {
      const payload = (await request.json().catch(() => ({}))) as Record<string, any>;
      const contactId = extractContactId(payload);
      if (!contactId) {
        console.warn("webhook without contact id", JSON.stringify(payload).slice(0, 500));
        return Response.json({ ok: false, error: "missing contact_id" }, { status: 400 });
      }
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(contactId));
      await stub.schedule(contactId);
      console.log(`[${contactId}] webhook received, reply scheduled`);
      return Response.json({ ok: true, queued: contactId });
    }

    // Try the agent without GHL side effects:
    // POST /simulate {"channel":"SMS","messages":[{"from":"customer","text":"..."}]}
    if (url.pathname === "/simulate" && request.method === "POST") {
      const body = (await request.json()) as {
        channel?: "SMS" | "IG";
        messages: { from: "customer" | "julia"; text: string }[];
      };
      const transcript = body.messages
        .map((m) => `${m.from === "customer" ? "Customer" : "High End Detail"}: ${m.text}`)
        .join("\n");
      const result = await runAgent({
        env,
        ghl: new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID),
        channel: body.channel ?? "SMS",
        transcript,
      });
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  },
};

function authorized(url: URL, request: Request, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) return false;
  const provided = url.searchParams.get("key") ?? request.headers.get("x-webhook-secret");
  return provided === env.WEBHOOK_SECRET;
}

function describeError(err: unknown): string {
  if (err instanceof GhlError) return `${err.message}: ${err.body}`;
  if (err instanceof Anthropic.APIError) return `Claude API ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

async function diagnose(env: Env, contactId: string | null, run: boolean) {
  const out: Record<string, unknown> = {
    secrets: {
      ANTHROPIC_API_KEY: Boolean(env.ANTHROPIC_API_KEY),
      GHL_TOKEN: Boolean(env.GHL_TOKEN),
      WEBHOOK_SECRET: Boolean(env.WEBHOOK_SECRET),
    },
    settings: { ONLY_TAG: env.ONLY_TAG, DRY_RUN: env.DRY_RUN, CLAUDE_MODEL: env.CLAUDE_MODEL, STOP_TAGS: env.STOP_TAGS },
  };
  const ghl = new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID);
  try {
    const now = Date.now();
    await ghl.getFreeSlots(CALENDARS[0].id, now, now + 2 * 86400_000, env.TIMEZONE);
    out.ghl = "ok";
  } catch (err) {
    out.ghl = describeError(err);
  }
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({
      model: env.CLAUDE_MODEL || "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the word OK." }],
    });
    out.claude = r.content.some((b) => b.type === "text") ? "ok" : `unexpected stop_reason ${r.stop_reason}`;
  } catch (err) {
    out.claude = describeError(err);
  }
  if (contactId) {
    try {
      const contact = await ghl.getContact(contactId);
      out.contact = { id: contact.id, tags: contact.tags ?? [], phone: Boolean(contact.phone) };
    } catch (err) {
      out.contact = describeError(err);
    }
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(contactId));
    if (run) {
      await stub.schedule(contactId);
      out.run = "reply scheduled; reload this page in ~40 seconds to see lastRun";
    }
    out.agent = await stub.status();
  }
  return out;
}

/** Accepts GHL workflow webhooks (contact_id / customData) and app-style InboundMessage events (contactId). */
function extractContactId(p: Record<string, any>): string | undefined {
  return p.customData?.contact_id ?? p.customData?.contactId ?? p.contact_id ?? p.contactId ?? p.contact?.id ?? undefined;
}

/**
 * One instance per contact. Each webhook pushes the alarm back (debounce), and
 * the alarm handler runs the agent once the customer has stopped typing.
 * Durable Objects process one event at a time, so a contact never gets two
 * replies generated concurrently.
 */
export class ConversationAgent extends DurableObject<Env> {
  async schedule(contactId: string): Promise<void> {
    await this.ctx.storage.put("contactId", contactId);
    await this.ctx.storage.put("lastWebhookAt", new Date().toISOString());
    const delay = Number(this.env.DEBOUNCE_SECONDS || "20") * 1000;
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async status() {
    const [lastWebhookAt, lastRun, alarm] = await Promise.all([
      this.ctx.storage.get<string>("lastWebhookAt"),
      this.ctx.storage.get("lastRun"),
      this.ctx.storage.getAlarm(),
    ]);
    return { lastWebhookAt: lastWebhookAt ?? null, pendingReplyAt: alarm ? new Date(alarm).toISOString() : null, lastRun: lastRun ?? null };
  }

  async alarm(): Promise<void> {
    const contactId = await this.ctx.storage.get<string>("contactId");
    if (!contactId) return;
    let outcome: string;
    try {
      outcome = await this.handle(contactId);
    } catch (err) {
      // Swallow errors so the runtime doesn't retry the alarm and risk a double reply.
      outcome = `error: ${describeError(err)}`;
      console.error(`[${contactId}] agent failed`, err);
    }
    await this.ctx.storage.put("lastRun", { at: new Date().toISOString(), outcome });
  }

  private async handle(contactId: string): Promise<string> {
    const env = this.env;
    const ghl = new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID);
    const log = (msg: string) => {
      console.log(`[${contactId}] ${msg}`);
      return msg;
    };

    const contact = await ghl.getContact(contactId);
    const tags = (contact.tags ?? []).map((t) => t.toLowerCase());
    const onlyTag = env.ONLY_TAG?.trim().toLowerCase();
    if (onlyTag && !tags.includes(onlyTag)) return log(`skip: missing tag "${env.ONLY_TAG}"`);
    const stopTag = csv(env.STOP_TAGS).find((t) => tags.includes(t.toLowerCase()));
    if (stopTag) return log(`skip: has stop tag "${stopTag}"`);

    const conversation = await ghl.findConversation(contactId);
    if (!conversation) return log("skip: no conversation");
    const recent = await ghl.getMessages(conversation.id, 40);
    const latest = recent.find(isChatMessage);
    if (!latest || latest.direction !== "inbound") return log("skip: latest message is not from the customer");
    const channel = CHANNELS[latest.messageType ?? ""];
    if (!channel) return log(`skip: channel ${latest.messageType} not handled`);

    const botIds = new Set((await this.ctx.storage.get<string[]>("sentIds")) ?? []);
    const botBodies = new Set((await this.ctx.storage.get<string[]>("sentBodies")) ?? []);
    const pauseMs = Number(env.HUMAN_PAUSE_HOURS || "12") * 3600_000;
    // A team member typing in GHL: an outbound chat message (not an activity
    // log entry like "New appointment created") that the agent didn't send.
    const humanReply = recent.find(
      (m) =>
        m.direction === "outbound" &&
        m.source === "app" &&
        isChatMessage(m) &&
        !botIds.has(m.id) &&
        !botBodies.has(m.body!.trim()),
    );
    if (humanReply && Date.now() - Date.parse(humanReply.dateAdded) < pauseMs) {
      return log("skip: a team member replied recently");
    }

    const transcript = renderTranscript(recent, botIds, env.TIMEZONE);
    const aiStart = Date.now();
    const result = await runAgent({ env, ghl, contact, channel, transcript });
    const aiMs = Date.now() - aiStart;
    log(`actions=${JSON.stringify(result.actions)} usage=${JSON.stringify(result.usage)}`);
    if (!result.reply) return log("no reply needed");

    // Don't send a stale answer if something changed while the model was thinking.
    const newest = (await ghl.getMessages(conversation.id, 5)).find(isChatMessage);
    if (newest && newest.id !== latest.id) return log("skip send: conversation moved on while generating");

    if (env.DRY_RUN === "true") {
      await ghl.addNote(contactId, `[AI draft, not sent] ${result.reply}`);
      return log(`dry run note: ${result.reply}`);
    }

    const messageId = await ghl.sendMessage(contactId, channel, result.reply);
    if (messageId) botIds.add(messageId);
    botBodies.add(result.reply.trim());
    await this.ctx.storage.put("sentIds", [...botIds].slice(-100));
    await this.ctx.storage.put("sentBodies", [...botBodies].slice(-50));

    // Where the seconds went, from the customer's message to our send.
    const webhookAt = Date.parse((await this.ctx.storage.get<string>("lastWebhookAt")) ?? "");
    const inboundAt = Date.parse(latest.dateAdded);
    const secs = (ms: number) => Math.round(ms / 100) / 10;
    const timing = `ghl_to_webhook=${secs(webhookAt - inboundAt)}s wait=${secs(aiStart - webhookAt)}s ai=${secs(aiMs)}s total=${secs(Date.now() - inboundAt)}s model_calls=${result.rounds}`;
    return log(`sent ${channel} (${timing}) to ${contactName(contact)}: ${result.reply}`);
  }
}

function isChatMessage(m: GhlMessage): boolean {
  return Boolean(m.body?.trim()) && (m.messageType ?? "").startsWith("TYPE_") && !(m.messageType ?? "").includes("ACTIVITY");
}

function renderTranscript(newestFirst: GhlMessage[], botIds: Set<string>, timeZone: string): string {
  return newestFirst
    .filter(isChatMessage)
    .reverse()
    .map((m) => {
      const who = m.direction === "inbound" ? "Customer" : botIds.has(m.id) ? "Julia (you)" : "High End Detail";
      const via = CHANNELS[m.messageType ?? ""] ?? m.messageType?.replace("TYPE_", "");
      return `[${formatInZone(new Date(m.dateAdded), timeZone)} via ${via}] ${who}: ${m.body!.trim()}`;
    })
    .join("\n");
}
