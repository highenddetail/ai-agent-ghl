import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { contactName, formatInZone, runAgent, upcomingAppointments } from "./agent";
import { csv, type Env } from "./env";
import { GhlClient, GhlError, type GhlMessage } from "./ghl";
import { CALENDARS } from "./knowledge";
import { decodeDepositNote, verifySquareSignature, type DepositNote } from "./square";
import { bookSlot, formatWhen, money, type DepositState } from "./deposits";
import { actionKind, estimateCost, eventLog, record, type AgentEvent, type EventKind } from "./events";
import { dashboardHtml, loginHtml, startOfToday } from "./dashboard";
import {
  advance,
  deferredSequence,
  describeSilence,
  followUpMode,
  followUpOffsets,
  inSendWindow,
  isOptOutKeyword,
  nextSendTime,
  startSequence,
  type FollowUpState,
} from "./followups";

export { EventLog } from "./events";
import { getCalendar } from "./knowledge";

const CHANNELS: Record<string, "SMS" | "IG"> = {
  TYPE_SMS: "SMS",
  TYPE_INSTAGRAM: "IG",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "hed-ai-agent" });
    }

    // Read-only dashboard at the root URL. The password is DASHBOARD_KEY (or WEBHOOK_SECRET if
    // no separate key is set); after logging in, a cookie keeps the browser signed in.
    if (["/", "/panel", "/dashboard", "/login", "/logout", "/api/events"].includes(url.pathname)) {
      return dashboardRoute(request, url, env);
    }

    // Square payment notifications are authenticated by their HMAC signature, not ?key=.
    if (url.pathname === "/webhook/square" && request.method === "POST") {
      const raw = await request.text();
      const ok = await verifySquareSignature(
        raw,
        request.headers.get("x-square-hmacsha256-signature"),
        url.origin + url.pathname,
        env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      );
      if (!ok) {
        console.warn("square webhook: bad signature");
        return new Response("invalid signature", { status: 401 });
      }
      try {
        return Response.json(await handleSquareEvent(env, JSON.parse(raw)));
      } catch (err) {
        console.error("square webhook failed", err);
        return Response.json({ ok: false, error: describeError(err) }, { status: 500 });
      }
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
        /** Write follow-up number N (1-5) instead of a reply. */
        followUp?: number;
      };
      const transcript = body.messages
        .map((m) => `${m.from === "customer" ? "Customer" : "High End Detail"}: ${m.text}`)
        .join("\n");
      const result = await runAgent({
        env,
        ghl: new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID),
        channel: body.channel ?? "SMS",
        transcript,
        followUp: body.followUp
          ? { number: body.followUp, total: followUpOffsets(env).length, silentFor: "a while" }
          : undefined,
      });
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  },
};

const PANEL_COOKIE = "hed_panel";
const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function panelToken(env: Env): Promise<string[]> {
  const keys = [env.DASHBOARD_KEY, env.WEBHOOK_SECRET].filter((k): k is string => Boolean(k));
  return Promise.all(keys.map((k) => sha256(`panel:${k}`)));
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function loginCookie(token: string, maxAge: number): string {
  return `${PANEL_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function dashboardRoute(request: Request, url: URL, env: Env): Promise<Response> {
  const tokens = await panelToken(env);
  const keys = [env.DASHBOARD_KEY, env.WEBHOOK_SECRET].filter(Boolean);
  const signedIn = tokens.includes(cookieValue(request, PANEL_COOKIE) ?? "");

  if (url.pathname === "/logout") {
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": loginCookie("", 0) } });
  }
  if (url.pathname === "/login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const password = String(form?.get("password") ?? "");
    const i = keys.indexOf(password);
    if (i < 0) return new Response(loginHtml("Contraseña incorrecta."), { status: 401, headers: HTML });
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": loginCookie(tokens[i], 90 * 86400) } });
  }
  // Old links with ?key= still work: sign in and drop the key from the address bar.
  const key = url.searchParams.get("key");
  if (key && keys.includes(key)) {
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": loginCookie(tokens[keys.indexOf(key)], 90 * 86400) } });
  }

  if (url.pathname === "/api/events") {
    if (!signedIn) return new Response("unauthorized", { status: 401 });
    const range = url.searchParams.get("range") ?? "today";
    const since = range === "30d" ? Date.now() - 30 * 86400_000 : range === "7d" ? Date.now() - 7 * 86400_000 : startOfToday(env.TIMEZONE);
    const log = eventLog(env);
    const [events, stats] = await Promise.all([
      log.list({ afterId: Number(url.searchParams.get("after") ?? 0) || 0, limit: 500 }),
      log.stats(since),
    ]);
    return Response.json({ since, events: events.filter((e) => e.ts >= since), stats }, { headers: { "cache-control": "no-store" } });
  }

  if (!signedIn) return new Response(loginHtml(""), { headers: HTML });
  if (url.pathname !== "/") return new Response(null, { status: 302, headers: { location: "/" } });
  const html = dashboardHtml({ locationId: env.GHL_LOCATION_ID, timeZone: env.TIMEZONE, model: env.CLAUDE_MODEL, onlyTag: env.ONLY_TAG });
  return new Response(html, { headers: HTML });
}

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

/** A completed deposit payment: hand it to the contact's agent, once per payment. */
async function handleSquareEvent(env: Env, event: Record<string, any>) {
  const payment = event?.data?.object?.payment;
  if (!payment || payment.status !== "COMPLETED") return { ok: true, ignored: "not a completed payment" };
  const deposit = decodeDepositNote(payment.note);
  if (!deposit) return { ok: true, ignored: "not an AI deposit" };

  const once = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`payment:${payment.id}`));
  if (!(await once.claimOnce())) return { ok: true, ignored: "already processed" };
  try {
    const agent = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(deposit.contactId));
    const outcome = await agent.depositPaid(String(payment.id), Number(payment.amount_money?.amount ?? 0), deposit);
    return { ok: true, contactId: deposit.contactId, outcome };
  } catch (err) {
    await once.releaseClaim(); // let Square's retry process it again
    throw err;
  }
}

/** Accepts GHL workflow webhooks (contact_id / customData) and app-style InboundMessage events (contactId). */
function extractContactId(p: Record<string, any>): string | undefined {
  return p.customData?.contact_id ?? p.customData?.contactId ?? p.contact_id ?? p.contactId ?? p.contact?.id ?? undefined;
}

/**
 * One instance per contact. Each webhook pushes the reply back (debounce), and
 * the alarm handler runs the agent once the customer has stopped typing.
 * The same alarm also wakes the contact's next follow-up: "replyAt" and
 * "followUp.dueAt" are the two things it can be waiting for, and the alarm is
 * always set to the earliest. Durable Objects process one event at a time, so
 * a contact never gets two messages generated concurrently.
 */
export class ConversationAgent extends DurableObject<Env> {
  /** Events gathered during one run, written to the dashboard log at the end. */
  private events: AgentEvent[] = [];
  private who = { name: "", channel: "" };

  private track(contactId: string, kind: EventKind, summary: string, extra: Partial<AgentEvent> = {}) {
    this.events.push({ ts: Date.now(), contactId, contactName: this.who.name, channel: this.who.channel, kind, summary, ...extra });
  }

  async schedule(contactId: string): Promise<void> {
    await this.ctx.storage.put("contactId", contactId);
    await this.ctx.storage.put("lastWebhookAt", new Date().toISOString());
    const delay = Number(this.env.DEBOUNCE_SECONDS || "20") * 1000;
    await this.ctx.storage.put("replyAt", Date.now() + delay);
    await this.rearm();
  }

  /** Points the alarm at whichever comes first: the pending reply or the next follow-up. */
  private async rearm(): Promise<void> {
    const replyAt = await this.ctx.storage.get<number>("replyAt");
    const followUp = await this.ctx.storage.get<FollowUpState>("followUp");
    const next = Math.min(replyAt ?? Infinity, followUp?.dueAt ?? Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  private async setFollowUp(state: FollowUpState | undefined): Promise<void> {
    if (state) await this.ctx.storage.put("followUp", state);
    else await this.ctx.storage.delete("followUp");
  }

  /** True the first time it's called on this object; used to process each Square payment once. */
  async claimOnce(): Promise<boolean> {
    if (await this.ctx.storage.get<boolean>("claimed")) return false;
    await this.ctx.storage.put("claimed", true);
    return true;
  }

  /** Square says the deposit is paid: book the held slot(s) and text the customer. */
  async depositPaid(paymentId: string, amountCents: number, note: DepositNote): Promise<string> {
    const env = this.env;
    const ghl = new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID);
    const contactId = note.contactId;
    const state = (await this.ctx.storage.get<DepositState>("deposit")) ?? {};
    const pending = state.pending;
    const lang = pending?.language ?? note.language;
    const channel = pending?.channel ?? note.channel;
    const paid = money(amountCents);

    await ghl.addTags(contactId, [env.DEPOSIT_PAID_TAG]);
    await ghl.removeTags(contactId, [env.DEPOSIT_PENDING_TAG]).catch((e) => console.error("removeTags failed", e));

    const booked: string[] = [];
    const missed: string[] = [];
    if (pending) {
      const contact = await ghl.getContact(contactId);
      for (const slot of pending.slots) {
        const cal = getCalendar(slot.calendarId);
        if (!cal) continue;
        const when = formatWhen(slot.startTime, env.TIMEZONE, lang);
        const result = await bookSlot(
          ghl,
          env,
          contact,
          cal,
          slot.startTime,
          `Booked by AI agent (Julia) after ${paid} deposit (Square payment ${paymentId}). ${slot.notes}`,
        ).catch((err) => ({ ok: false as const, reason: describeError(err) }));
        if (result.ok) booked.push(`${cal.name}, ${when}`);
        else missed.push(`${cal.name}, ${when}`);
      }
    }

    let message: string;
    if (pending && missed.length === 0) {
      state.pending = undefined;
      message =
        lang === "es"
          ? `Recibimos tu depósito de ${paid}, gracias. Tu cita quedó confirmada: ${booked.join("; ")}. Te esperamos en 11801 SW 144th Ct #5, Miami.`
          : `Got your ${paid} deposit, thank you. You're booked: ${booked.join("; ")}. See you at 11801 SW 144th Ct #5, Miami.`;
    } else {
      // Paid, but nothing held or the time was taken while paying: keep the deposit as credit.
      state.pending = undefined;
      state.credit = { amountCents, paymentId, services: missed.join("; ") || "their service", at: new Date().toISOString() };
      const took = missed.length ? (lang === "es" ? ` El horario de ${missed.join(" y ")} se ocupó mientras se procesaba el pago.` : ` The ${missed.join(" and ")} time was taken while the payment went through.`) : "";
      const done = booked.length ? (lang === "es" ? ` Ya quedó: ${booked.join("; ")}.` : ` Booked: ${booked.join("; ")}.`) : "";
      message =
        lang === "es"
          ? `Recibimos tu depósito de ${paid}, gracias.${done}${took} ¿Qué otro día y hora te funciona? Tu depósito ya cuenta.`
          : `Got your ${paid} deposit, thank you.${done}${took} What other day and time works for you? Your deposit is already applied.`;
    }
    await this.ctx.storage.put("deposit", state);
    // Paid: no more follow-ups. If the time was taken while paying, the deposit credit hands it to the team.
    await this.setFollowUp(undefined);
    await this.rearm();

    await ghl
      .addNote(contactId, `Deposit paid: ${paid} via Square (payment ${paymentId}). Booked: ${booked.join("; ") || "none"}. Not booked: ${missed.join("; ") || "none"}.`)
      .catch((e) => console.error("addNote failed", e));
    const messageId = await ghl.sendMessage(contactId, channel, message);
    await this.rememberSent(messageId ?? null, message);
    const outcome = `deposit ${paid} paid; booked=${booked.length} missed=${missed.length}`;
    let name = contactId;
    try {
      const c = await ghl.getContact(contactId);
      name = contactName(c) || c.phone || contactId;
    } catch {}
    const base = { ts: Date.now(), contactId, contactName: name, channel };
    await record(env, [
      { ...base, kind: "deposit_paid", summary: `Deposit ${paid} paid (Square ${paymentId})`, amountCents },
      ...booked.map((b) => ({ ...base, kind: "booking" as const, summary: `booked after deposit: ${b}` })),
      ...missed.map((m) => ({ ...base, kind: "error" as const, summary: `paid but slot taken: ${m}; deposit kept as credit` })),
      { ...base, kind: "reply", summary: message },
    ]);
    console.log(`[${contactId}] ${outcome}`);
    await this.ctx.storage.put("lastRun", { at: new Date().toISOString(), outcome });
    return outcome;
  }

  async releaseClaim(): Promise<void> {
    await this.ctx.storage.delete("claimed");
  }

  /** Remember a message sent on the agent's behalf so it isn't mistaken for a team member. */
  async rememberSent(messageId: string | null, body: string): Promise<void> {
    const ids = (await this.ctx.storage.get<string[]>("sentIds")) ?? [];
    const bodies = (await this.ctx.storage.get<string[]>("sentBodies")) ?? [];
    if (messageId) ids.push(messageId);
    bodies.push(body.trim());
    await this.ctx.storage.put("sentIds", ids.slice(-100));
    await this.ctx.storage.put("sentBodies", bodies.slice(-50));
  }

  async status() {
    const [lastWebhookAt, lastRun, replyAt, followUp] = await Promise.all([
      this.ctx.storage.get<string>("lastWebhookAt"),
      this.ctx.storage.get("lastRun"),
      this.ctx.storage.get<number>("replyAt"),
      this.ctx.storage.get<FollowUpState>("followUp"),
    ]);
    const deposit = (await this.ctx.storage.get("deposit")) ?? null;
    return {
      lastWebhookAt: lastWebhookAt ?? null,
      pendingReplyAt: replyAt ? new Date(replyAt).toISOString() : null,
      followUp: followUp ? { ...followUp, nextAt: new Date(followUp.dueAt).toISOString() } : null,
      lastRun: lastRun ?? null,
      deposit,
    };
  }

  async alarm(): Promise<void> {
    const contactId = await this.ctx.storage.get<string>("contactId");
    if (!contactId) return;
    const now = Date.now() + 1000;
    const replyAt = await this.ctx.storage.get<number>("replyAt");
    const followUp = await this.ctx.storage.get<FollowUpState>("followUp");
    // Alarms set before follow-ups existed carry no "replyAt": treat them as a reply.
    const replyDue = replyAt !== undefined ? replyAt <= now : !followUp;
    if (replyDue) {
      await this.ctx.storage.delete("replyAt");
      await this.run(contactId, () => this.handle(contactId));
    } else if (followUp && followUp.dueAt <= now) {
      // If this run throws, try again in an hour instead of looping on a past due time.
      await this.setFollowUp({ ...followUp, dueAt: nextSendTime(this.env, Date.now() + 3600_000) });
      await this.run(contactId, () => this.followUp(contactId, followUp));
    }
    await this.rearm();
  }

  private async run(contactId: string, job: () => Promise<string>): Promise<void> {
    let outcome: string;
    this.events = [];
    this.who = { name: "", channel: "" };
    try {
      outcome = await job();
    } catch (err) {
      // Swallow errors so the runtime doesn't retry the alarm and risk a double message.
      outcome = `error: ${describeError(err)}`;
      console.error(`[${contactId}] agent failed`, err);
      this.track(contactId, "error", describeError(err));
    }
    await this.ctx.storage.put("lastRun", { at: new Date().toISOString(), outcome });
    await record(this.env, this.events);
  }

  private async handle(contactId: string): Promise<string> {
    const env = this.env;
    const ghl = new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID);
    const log = (msg: string) => {
      console.log(`[${contactId}] ${msg}`);
      return msg;
    };
    const skip = (reason: string) => {
      this.track(contactId, "skip", reason);
      return log(`skip: ${reason}`);
    };

    const contact = await ghl.getContact(contactId);
    this.who.name = contactName(contact) || contact.phone || contactId;
    const tags = (contact.tags ?? []).map((t) => t.toLowerCase());
    const onlyTag = env.ONLY_TAG?.trim().toLowerCase();
    if (onlyTag && !tags.includes(onlyTag)) return skip(`missing tag "${env.ONLY_TAG}"`);
    const stopTag = csv(env.STOP_TAGS).find((t) => tags.includes(t.toLowerCase()));
    if (stopTag) return skip(`has stop tag "${stopTag}"`);

    const conversation = await ghl.findConversation(contactId);
    if (!conversation) return skip("no conversation");
    const recent = await ghl.getMessages(conversation.id, 40);
    const latest = recent.find(isChatMessage);
    if (!latest || latest.direction !== "inbound") return skip("latest message is not from the customer");
    // The customer wrote: any follow-up sequence is over. A new one starts after Julia's answer.
    await this.setFollowUp(undefined);
    const channel = CHANNELS[latest.messageType ?? ""];
    if (!channel) return skip(`channel ${latest.messageType} not handled`);
    this.who.channel = channel;
    if ((await this.ctx.storage.get<string>("lastInboundLogged")) !== latest.id) {
      await this.ctx.storage.put("lastInboundLogged", latest.id);
      // Log every customer message since the last reply, oldest first.
      const unanswered: GhlMessage[] = [];
      for (const m of recent) {
        if (!isChatMessage(m)) continue;
        if (m.direction !== "inbound") break;
        unanswered.unshift(m);
      }
      for (const m of unanswered) this.track(contactId, "message_in", m.body!.trim(), { ts: Date.parse(m.dateAdded) });
    }

    if (isOptOutKeyword(latest.body!)) {
      await ghl.addTags(contactId, [env.FOLLOWUP_OPTOUT_TAG]).catch((e) => console.error("addTags failed", e));
      this.track(contactId, "follow_up_stopped", `customer texted "${latest.body!.trim()}"`);
      return skip("opt-out keyword: no reply, no follow-ups");
    }

    const botIds = new Set((await this.ctx.storage.get<string[]>("sentIds")) ?? []);
    const botBodies = new Set((await this.ctx.storage.get<string[]>("sentBodies")) ?? []);
    const pauseMs = Number(env.HUMAN_PAUSE_MINUTES || "5") * 60_000;
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
      // Look again when the pause ends: if the team didn't answer the customer by then, Julia does.
      const retryAt = Date.parse(humanReply.dateAdded) + pauseMs + 5_000;
      await this.ctx.storage.put("replyAt", retryAt);
      return skip(`a team member replied recently; will answer at ${formatInZone(new Date(retryAt), env.TIMEZONE)} if nobody else does`);
    }

    const transcript = renderTranscript(recent, botIds, env.TIMEZONE);
    const aiStart = Date.now();
    const deposit = (await this.ctx.storage.get<DepositState>("deposit")) ?? {};
    const result = await runAgent({ env, ghl, contact, channel, transcript, deposit });
    await this.ctx.storage.put("deposit", result.deposit);
    const aiMs = Date.now() - aiStart;
    log(`actions=${JSON.stringify(result.actions)} usage=${JSON.stringify(result.usage)}`);
    const costUsd = estimateCost(env.CLAUDE_MODEL || "claude-sonnet-5-5", result.usage);
    for (const action of result.actions) {
      const kind = actionKind(action);
      if (kind) this.track(contactId, kind, action);
    }
    if (!result.reply) {
      this.track(contactId, "skip", `no reply needed (${result.actions.join("; ") || "model chose NO_REPLY"})`, { costUsd, calls: result.rounds });
      if (result.followUp?.on) await this.setFollowUp(deferredSequence(env, channel, result.followUp.on.date, result.followUp.on.reason));
      return log("no reply needed");
    }

    // Don't send a stale answer if something changed while the model was thinking.
    const newest = (await ghl.getMessages(conversation.id, 5)).find(isChatMessage);
    if (newest && newest.id !== latest.id) {
      this.track(contactId, "skip", "conversation moved on while generating; next run answers", { costUsd, calls: result.rounds });
      return log("skip send: conversation moved on while generating");
    }

    if (env.DRY_RUN === "true") {
      await ghl.addNote(contactId, `[AI draft, not sent] ${result.reply}`);
      this.track(contactId, "reply", `[draft, not sent] ${result.reply}`, { costUsd, calls: result.rounds, ms: aiMs });
      return log(`dry run note: ${result.reply}`);
    }

    const messageId = await ghl.sendMessage(contactId, channel, result.reply);
    if (messageId) botIds.add(messageId);
    botBodies.add(result.reply.trim());
    await this.ctx.storage.put("sentIds", [...botIds].slice(-100));
    await this.ctx.storage.put("sentBodies", [...botBodies].slice(-50));

    // Julia's message is out: if the customer goes quiet now, the follow-up cadence starts from it.
    const escalated = result.actions.some((a) => a.startsWith("escalated"));
    if (followUpMode(env) !== "off" && !escalated && !result.followUp?.stop && !tags.includes(env.FOLLOWUP_OPTOUT_TAG.toLowerCase())) {
      const on = result.followUp?.on;
      await this.setFollowUp(on ? deferredSequence(env, channel, on.date, on.reason) : startSequence(env, channel));
    }

    // Where the seconds went, from the customer's message to our send.
    const webhookAt = Date.parse((await this.ctx.storage.get<string>("lastWebhookAt")) ?? "");
    const inboundAt = Date.parse(latest.dateAdded);
    const secs = (ms: number) => Math.round(ms / 100) / 10;
    this.track(contactId, "reply", result.reply, { costUsd, calls: result.rounds, ms: Date.now() - Date.parse(latest.dateAdded) });
    const timing = `ghl_to_webhook=${secs(webhookAt - inboundAt)}s wait=${secs(aiStart - webhookAt)}s ai=${secs(aiMs)}s total=${secs(Date.now() - inboundAt)}s model_calls=${result.rounds}`;
    return log(`sent ${channel} (${timing}) to ${contactName(contact)}: ${result.reply}`);
  }

  /** The customer went quiet: write the next follow-up, unless something says the sequence is over. */
  private async followUp(contactId: string, state: FollowUpState): Promise<string> {
    const env = this.env;
    const ghl = new GhlClient(env.GHL_TOKEN, env.GHL_LOCATION_ID);
    const log = (msg: string) => {
      console.log(`[${contactId}] follow-up: ${msg}`);
      return `follow-up: ${msg}`;
    };
    const end = async (reason: string) => {
      await this.setFollowUp(undefined);
      this.track(contactId, "follow_up_stopped", reason);
      return log(`stopped: ${reason}`);
    };
    const mode = followUpMode(env);
    if (mode === "off") return end("follow-ups are off");
    if (!inSendWindow(env, Date.now())) {
      await this.setFollowUp({ ...state, dueAt: nextSendTime(env, Date.now()) });
      return log("outside the send window, moved to the next opening");
    }

    const contact = await ghl.getContact(contactId);
    this.who.name = contactName(contact) || contact.phone || contactId;
    this.who.channel = state.channel;
    const tags = (contact.tags ?? []).map((t) => t.toLowerCase());
    const onlyTag = env.ONLY_TAG?.trim().toLowerCase();
    if (onlyTag && !tags.includes(onlyTag)) return end(`missing tag "${env.ONLY_TAG}"`);
    const blocking = [...csv(env.STOP_TAGS), env.FOLLOWUP_OPTOUT_TAG].find((t) => tags.includes(t.toLowerCase()));
    if (blocking) return end(`has tag "${blocking}"`);
    if (contact.dnd) return end("contact is on Do Not Disturb");

    const conversation = await ghl.findConversation(contactId);
    if (!conversation) return end("no conversation");
    const recent = await ghl.getMessages(conversation.id, 40);
    const latest = recent.find(isChatMessage);
    const botIds = new Set((await this.ctx.storage.get<string[]>("sentIds")) ?? []);
    const botBodies = new Set((await this.ctx.storage.get<string[]>("sentBodies")) ?? []);
    if (!latest) return end("no messages");
    if (latest.direction === "inbound") return end("the customer replied");
    if (!botIds.has(latest.id) && !botBodies.has(latest.body!.trim())) return end("a team member wrote last; the team has it");

    const deposit = (await this.ctx.storage.get<DepositState>("deposit")) ?? {};
    if (deposit.credit) return end("deposit paid, waiting on a new time; the team has it");
    if ((await upcomingAppointments(ghl, contactId, env.TIMEZONE)).length > 0) return end("has an upcoming appointment");

    // Instagram only allows business messages within 24 hours of the customer's last message.
    let channel = state.channel;
    let smsAfterIg = false;
    const lastInbound = recent.find((m) => isChatMessage(m) && m.direction === "inbound");
    if (channel === "IG" && (!lastInbound || Date.now() - Date.parse(lastInbound.dateAdded) > 23 * 3600_000)) {
      if (!contact.phone) return end("Instagram's 24-hour window closed and there's no phone number for SMS");
      channel = "SMS";
      smsAfterIg = !recent.some((m) => isChatMessage(m) && m.messageType === "TYPE_SMS");
    }
    this.who.channel = channel;

    const total = followUpOffsets(env).length;
    const number = state.deferred ? 1 : state.sent + 1;
    const aiStart = Date.now();
    const result = await runAgent({
      env,
      ghl,
      contact,
      channel,
      transcript: renderTranscript(recent, botIds, env.TIMEZONE),
      deposit,
      followUp: {
        number,
        total: state.deferred ? 1 : total,
        silentFor: describeSilence(Date.now() - Date.parse(latest.dateAdded)),
        smsAfterIg,
        deferred: state.deferred,
      },
    });
    const costUsd = estimateCost(env.CLAUDE_MODEL || "claude-sonnet-5-5", result.usage);
    log(`actions=${JSON.stringify(result.actions)} usage=${JSON.stringify(result.usage)}`);
    if (result.followUp?.stop) return end(result.followUp.stop);
    if (result.followUp?.on) {
      await this.setFollowUp(deferredSequence(env, state.channel, result.followUp.on.date, result.followUp.on.reason));
      this.track(contactId, "skip", `follow-up moved to ${result.followUp.on.date}: ${result.followUp.on.reason}`, { costUsd, calls: result.rounds });
      return log(`moved to ${result.followUp.on.date}`);
    }
    if (!result.reply) {
      await this.setFollowUp(undefined);
      this.track(contactId, "follow_up_stopped", "Julia judged the conversation closed (NO_REPLY)", { costUsd, calls: result.rounds });
      return log("model chose NO_REPLY; sequence ended");
    }

    const newest = (await ghl.getMessages(conversation.id, 5)).find(isChatMessage);
    if (newest && newest.id !== latest.id) return log("conversation moved on while generating; skipped");

    const label = `#${number}${state.deferred ? " (date they asked for)" : ""}`;
    if (mode === "draft") {
      await ghl.addNote(contactId, `[AI follow-up ${label}, draft, not sent] ${result.reply}`);
      this.track(contactId, "follow_up", `[draft ${label}, not sent] ${result.reply}`, { costUsd, calls: result.rounds, ms: Date.now() - aiStart });
    } else {
      const messageId = await ghl.sendMessage(contactId, channel, result.reply);
      await this.rememberSent(messageId ?? null, result.reply);
      this.track(contactId, "follow_up", `${label} ${result.reply}`, { costUsd, calls: result.rounds, ms: Date.now() - aiStart });
    }
    const next = advance(env, { ...state, channel });
    await this.setFollowUp(next);
    return log(`${mode === "draft" ? "drafted" : `sent ${channel}`} ${label}; ${next ? `next at ${formatInZone(new Date(next.dueAt), env.TIMEZONE)}` : "sequence finished"}`);
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
