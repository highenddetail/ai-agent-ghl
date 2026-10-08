// Live dashboard served by the Worker at /dashboard?key=... It polls
// /api/events every few seconds and renders the agent's activity.

/** Midnight today in `timeZone`, as epoch ms. */
export function startOfToday(timeZone: string): number {
  const day = new Date().toLocaleDateString("en-CA", { timeZone });
  const probe = new Date(`${day}T12:00:00Z`);
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(probe)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  const offset = m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00";
  return Date.parse(`${day}T00:00:00${offset}`);
}

export function loginHtml(error: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Julia Control Room</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,800&family=Bai+Jamjuree:wght@400;600&display=swap">
<style>
:root { --bg: #eef1f6; --surface: #fff; --ink: #130e09; --muted: #5a6170; --line: #d8dee8; --blue: #0033a1; --red: #e1251b; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c111d; --surface: #141b2b; --ink: #e8ecf4; --muted: #9aa4b6; --line: #273249; --blue: #7aa0ff; --red: #ff6a5f; color-scheme: dark; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 "Bai Jamjuree", system-ui, sans-serif; display: grid; place-items: center; padding-inline: 16px; }
form { width: min(360px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 24px; display: grid; gap: 12px; }
h1 { margin: 0; font: 800 20px/1.1 "Archivo", "Arial Black", sans-serif; font-stretch: 125%; letter-spacing: .04em; text-transform: uppercase; color: var(--blue); }
p { margin: 0; color: var(--muted); font-size: 14px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
input { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: 16px inherit; background: var(--bg); color: var(--ink); }
button { border: 0; border-radius: 999px; padding: 10px; background: var(--blue); color: #fff; font: 600 15px inherit; cursor: pointer; }
.err { color: var(--red); font-size: 14px; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Julia · Control Room</h1>
  <p>High End Detail. Entra con la contraseña del panel.</p>
  ${error ? `<span class="err">${error}</span>` : ""}
  <label for="password">Contraseña<input id="password" name="password" type="password" autocomplete="current-password" required autofocus></label>
  <button type="submit">Entrar</button>
</form>
</body>
</html>`;
}

export function dashboardHtml(opts: { locationId: string; timeZone: string; model: string; onlyTag: string }): string {
  const cfg = JSON.stringify(opts).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Julia Control Room</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,700;125,800&family=Bai+Jamjuree:wght@400;500;600&display=swap">
<style>
/* Layout: KPI strip on top, live feed (wide) beside the active-contacts rail; one column on phones. */
:root {
  --bg: #eef1f6; --surface: #ffffff; --surface-2: #f6f8fb; --ink: #130e09; --muted: #5a6170; --line: #d8dee8;
  --blue: #0033a1; --blue-soft: #e4ebf8; --red: #e1251b; --red-soft: #fde8e7;
  --ok: #1d7a46; --ok-soft: #e1f3e8; --warn: #9a5b00; --warn-soft: #fbf0dc; --violet: #5b3fb5; --violet-soft: #ece7fb;
  --f-display: "Archivo", "Arial Black", system-ui, sans-serif;
  --f-body: "Bai Jamjuree", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0c111d; --surface: #141b2b; --surface-2: #1a2336; --ink: #e8ecf4; --muted: #9aa4b6; --line: #273249;
    --blue: #7aa0ff; --blue-soft: #1c2a4d; --red: #ff6a5f; --red-soft: #3a1a1a;
    --ok: #5fd08e; --ok-soft: #15301f; --warn: #f0b45a; --warn-soft: #382b14; --violet: #b39dff; --violet-soft: #2a2245;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--f-body); }
.wrap { max-width: 1280px; margin: 0 auto; padding-inline: 16px; padding-block: 20px 40px; display: grid; gap: 16px; }
header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 12px; }
h1 { margin: 0; font: 800 22px/1.1 var(--f-display); font-stretch: 125%; letter-spacing: .04em; text-transform: uppercase; color: var(--blue); }
.sub { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.live { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 0 var(--ok); }
.dot.off { background: var(--red); }
@media (prefers-reduced-motion: no-preference) { .dot:not(.off) { animation: pulse 2s infinite; } }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); padding: 3px; }
.seg button { border: 0; background: transparent; color: var(--muted); font: 600 13px var(--f-body); padding: 5px 12px; border-radius: 999px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--blue); color: #fff; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.kpi .note { font-size: 12px; color: var(--muted); }
.kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; display: grid; gap: 2px; }
.kpi .label { font-size: 12px; color: var(--muted); letter-spacing: .03em; }
.kpi .value { font: 700 24px/1.2 var(--f-display); font-stretch: 125%; font-variant-numeric: tabular-nums; }
.kpi.money .value { color: var(--ok); }
.kpi.alert .value { color: var(--red); }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
@media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.panel-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.panel-head h2 { margin: 0; font: 600 12px var(--f-body); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); border-radius: 999px; padding: 3px 10px; font: 500 12px var(--f-body); cursor: pointer; }
.chip[aria-pressed="true"] { border-color: var(--blue); background: var(--blue-soft); color: var(--blue); }
input[type=search] { border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; font: 14px var(--f-body); background: var(--surface-2); color: var(--ink); min-width: 0; width: 200px; }
.feed { list-style: none; margin: 0; padding: 0; max-height: 72vh; overflow-y: auto; }
.ev { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.ev.new { background: var(--blue-soft); transition: background 2s; }
.ev time { white-space: nowrap; font: 12px var(--f-mono); color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 2px; }
.ev .top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ev .who { font-weight: 600; cursor: pointer; }
.ev .who:hover { color: var(--blue); }
.ev .text { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ev .meta { margin-top: 2px; font: 12px var(--f-mono); color: var(--muted); }
.ch { font: 600 11px var(--f-mono); padding: 1px 6px; border-radius: 5px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line); }
.k { font: 600 11px var(--f-body); padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
.k.message_in { background: var(--surface-2); color: var(--ink); }
.k.reply, .k.follow_up { background: var(--blue-soft); color: var(--blue); }
.k.booking, .k.deposit_paid { background: var(--ok-soft); color: var(--ok); }
.k.deposit_link, .k.buying_intent, .k.rescheduled, .k.phone_saved { background: var(--violet-soft); color: var(--violet); }
.k.escalated, .k.cancelled, .k.skip, .k.follow_up_stopped { background: var(--warn-soft); color: var(--warn); }
.k.error { background: var(--red-soft); color: var(--red); }
.contacts { list-style: none; margin: 0; padding: 0; max-height: 72vh; overflow-y: auto; }
.contacts li { padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer; display: grid; gap: 2px; }
.contacts li:hover, .contacts li[aria-current="true"] { background: var(--surface-2); }
.contacts .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.contacts .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contacts .last { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contacts a { font-size: 12px; color: var(--blue); }
.empty { padding: 28px 14px; color: var(--muted); text-align: center; }
.banner { padding: 10px 14px; border-radius: 12px; background: var(--red-soft); color: var(--red); }
.foot { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Julia · Control Room</h1>
      <p class="sub" id="sub">High End Detail · agente de SMS e Instagram</p>
    </div>
    <div class="controls">
      <span class="live"><span class="dot" id="dot"></span><span id="live">Conectando…</span></span>
      <div class="seg" role="group" aria-label="Periodo">
        <button type="button" data-range="today" aria-pressed="true">Hoy</button>
        <button type="button" data-range="7d" aria-pressed="false">7 días</button>
        <button type="button" data-range="30d" aria-pressed="false">30 días</button>
      </div>
    </div>
  </header>

  <div id="error" class="banner" hidden></div>

  <section class="kpis" aria-label="Resumen">
    <div class="kpi"><span class="label">Clientes atendidos</span><span class="value" id="k-contacts">–</span></div>
    <div class="kpi"><span class="label">Respuestas enviadas</span><span class="value" id="k-replies">–</span></div>
    <div class="kpi"><span class="label">Citas agendadas</span><span class="value" id="k-bookings">–</span></div>
    <div class="kpi money"><span class="label">Depósitos cobrados</span><span class="value" id="k-deposits">–</span><span class="note" id="k-links"></span></div>
    <div class="kpi"><span class="label">Pasados al equipo</span><span class="value" id="k-escalated">–</span></div>
    <div class="kpi"><span class="label">Respuesta promedio</span><span class="value" id="k-speed">–</span></div>
    <div class="kpi"><span class="label">Costo API (estimado)</span><span class="value" id="k-cost">–</span></div>
    <div class="kpi alert"><span class="label">Errores</span><span class="value" id="k-errors">–</span></div>
  </section>

  <div class="grid">
    <section class="panel" aria-label="Actividad en vivo">
      <div class="panel-head">
        <h2 id="feed-title">Actividad en vivo</h2>
        <input type="search" id="search" placeholder="Buscar cliente o texto" aria-label="Buscar">
      </div>
      <div class="panel-head">
        <div class="filters" id="filters"></div>
      </div>
      <ul class="feed" id="feed"><li class="empty">Cargando actividad…</li></ul>
    </section>

    <aside class="panel" aria-label="Clientes activos">
      <div class="panel-head"><h2>Clientes</h2><button type="button" class="chip" id="all-contacts" hidden>Ver todos</button></div>
      <ul class="contacts" id="contacts"><li class="empty">Sin actividad todavía.</li></ul>
    </aside>
  </div>
  <p class="foot" id="foot"></p>
</div>
<script>
const CFG = ${cfg};

const LABELS = {
  message_in: "Mensaje del cliente", reply: "Respuesta de Julia", skip: "Sin respuesta", error: "Error",
  buying_intent: "Intención de compra", deposit_link: "Link de depósito", deposit_paid: "Depósito pagado",
  booking: "Cita agendada", rescheduled: "Cita movida", cancelled: "Cita cancelada", escalated: "Pasado al equipo",
  phone_saved: "Teléfono guardado", follow_up: "Seguimiento", follow_up_stopped: "Seguimiento detenido",
};
const FILTERS = [
  ["all", "Todo"], ["conv", "Conversación"], ["money", "Citas y pagos"], ["attention", "Requiere atención"],
];
const GROUPS = {
  conv: ["message_in", "reply", "follow_up", "follow_up_stopped"],
  money: ["booking", "deposit_link", "deposit_paid", "rescheduled", "cancelled", "buying_intent"],
  attention: ["escalated", "error", "skip"],
};
const state = { events: [], lastId: 0, range: "today", filter: "all", contact: null, q: "", lastOk: 0 };
const $ = (id) => document.getElementById(id);
const fmtTime = (ts) => new Date(ts).toLocaleString("es-US", { timeZone: CFG.timeZone, hour: "numeric", minute: "2-digit" });
const fmtDay = (ts) => new Date(ts).toLocaleDateString("es-US", { timeZone: CFG.timeZone, day: "numeric", month: "short" });
const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clean = (s) => s.replace(/^(booked after deposit: |booked |escalated: |buying intent: |deposit link |cancelled |rescheduled |saved phone )/i, "");
const ghlUrl = (id) => "https://app.gohighlevel.com/v2/location/" + CFG.locationId + "/contacts/detail/" + id;

$("sub").textContent = "High End Detail · modelo " + CFG.model + (CFG.onlyTag ? " · solo contactos con tag " + CFG.onlyTag : " · todos los contactos");

for (const [id, label] of FILTERS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip"; b.textContent = label; b.dataset.f = id;
  b.setAttribute("aria-pressed", String(id === "all"));
  b.onclick = () => { state.filter = id; document.querySelectorAll("#filters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.f === id))); renderFeed(); };
  $("filters").append(b);
}
document.querySelectorAll("[data-range]").forEach((b) => b.onclick = () => {
  state.range = b.dataset.range;
  document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  poll(true);
});
$("search").oninput = (e) => { state.q = e.target.value.toLowerCase(); renderFeed(); };
$("all-contacts").onclick = () => selectContact(null);

function selectContact(id) {
  state.contact = id;
  $("all-contacts").hidden = !id;
  const ev = state.events.find((e) => e.contactId === id);
  $("feed-title").textContent = id ? "Historial · " + (ev ? ev.contactName : id) : "Actividad en vivo";
  renderFeed(); renderContacts();
}

function visible(e) {
  if (state.contact && e.contactId !== state.contact) return false;
  if (state.filter !== "all" && !GROUPS[state.filter].includes(e.kind)) return false;
  if (state.q && !(e.contactName + " " + e.summary).toLowerCase().includes(state.q)) return false;
  return true;
}

function renderFeed(newIds = new Set()) {
  const list = state.events.filter(visible);
  const feed = $("feed");
  feed.innerHTML = "";
  if (!list.length) { feed.innerHTML = '<li class="empty">' + (state.events.length ? "Nada con este filtro." : "Todavía no hay actividad en este periodo. Cuando un cliente escriba, aparece aquí al instante.") + "</li>"; return; }
  for (const e of list.slice(0, 400)) {
    const li = document.createElement("li");
    li.className = "ev" + (newIds.has(e.id) ? " new" : "");
    const t = document.createElement("time");
    t.textContent = fmtTime(e.ts); t.title = new Date(e.ts).toLocaleString("es-US", { timeZone: CFG.timeZone });
    if (state.range !== "today") t.textContent = fmtDay(e.ts) + " " + fmtTime(e.ts);
    const body = document.createElement("div");
    const top = document.createElement("div"); top.className = "top";
    const who = document.createElement("span"); who.className = "who"; who.textContent = e.contactName || e.contactId; who.onclick = () => selectContact(e.contactId);
    const k = document.createElement("span"); k.className = "k " + e.kind; k.textContent = LABELS[e.kind] || e.kind;
    top.append(who);
    if (e.channel) { const ch = document.createElement("span"); ch.className = "ch"; ch.textContent = e.channel === "IG" ? "Instagram" : e.channel; top.append(ch); }
    top.append(k);
    const text = document.createElement("div"); text.className = "text"; text.textContent = clean(e.summary);
    body.append(top, text);
    const meta = [];
    if (e.kind === "reply" && e.ms) meta.push("respondió en " + Math.round(e.ms / 1000) + " s");
    if (e.calls) meta.push(e.calls + " consulta" + (e.calls > 1 ? "s" : "") + " a Claude");
    if (e.costUsd) meta.push("$" + e.costUsd.toFixed(3));
    if (e.amountCents) meta.push(money(e.amountCents));
    if (meta.length) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta.join(" · "); body.append(m); }
    li.append(t, body);
    feed.append(li);
  }
}

function renderContacts() {
  const by = new Map();
  for (const e of state.events) if (!by.has(e.contactId)) by.set(e.contactId, e);
  const ul = $("contacts"); ul.innerHTML = "";
  if (!by.size) { ul.innerHTML = '<li class="empty">Sin actividad todavía.</li>'; return; }
  for (const [id, e] of by) {
    const li = document.createElement("li");
    if (id === state.contact) li.setAttribute("aria-current", "true");
    const row = document.createElement("div"); row.className = "row";
    const n = document.createElement("span"); n.className = "name"; n.textContent = e.contactName || id;
    const k = document.createElement("span"); k.className = "k " + e.kind; k.textContent = LABELS[e.kind] || e.kind;
    row.append(n, k);
    const last = document.createElement("span"); last.className = "last"; last.textContent = fmtTime(e.ts) + " · " + clean(e.summary);
    const a = document.createElement("a"); a.href = ghlUrl(id); a.target = "_blank"; a.rel = "noopener"; a.textContent = "Abrir en GHL"; a.onclick = (ev) => ev.stopPropagation();
    li.append(row, last, a);
    li.onclick = () => selectContact(id);
    ul.append(li);
  }
}

function renderStats(s) {
  const k = s.byKind || {};
  $("k-contacts").textContent = s.contacts;
  $("k-replies").textContent = k.reply || 0;
  $("k-bookings").textContent = k.booking || 0;
  $("k-links").textContent = (k.deposit_paid || 0) + " de " + (k.deposit_link || 0) + " links pagados";
  $("k-deposits").textContent = money(s.depositsCents || 0);
  $("k-escalated").textContent = k.escalated || 0;
  $("k-errors").textContent = k.error || 0;
  $("k-speed").textContent = s.avgReplyMs ? Math.round(s.avgReplyMs / 1000) + " s" : "–";
  $("k-cost").textContent = "$" + (s.costUsd || 0).toFixed(2);
}

let busy = false;
async function poll(reset = false) {
  if (busy) return; busy = true;
  try {
    if (reset) { state.events = []; state.lastId = 0; }
    const r = await fetch("/api/events?after=" + state.lastId + "&range=" + state.range, { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) { location.href = "/"; return; }
    if (!r.ok) throw new Error("El servidor respondió " + r.status);
    const data = await r.json();
    const newIds = new Set();
    if (data.events.length) {
      for (const e of data.events) newIds.add(e.id);
      state.events = data.events.concat(state.events).filter((e) => e.ts >= data.since).sort((a, b) => b.id - a.id);
      state.lastId = state.events[0].id;
    }
    renderStats(data.stats);
    renderFeed(reset ? new Set() : newIds);
    renderContacts();
    state.lastOk = Date.now();
    $("error").hidden = true;
  } catch (err) {
    $("error").textContent = err.message || "No se pudo actualizar.";
    $("error").hidden = false;
  } finally { busy = false; }
}
setInterval(() => {
  const ago = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : null;
  const ok = ago !== null && ago < 20;
  $("dot").classList.toggle("off", !ok);
  $("live").textContent = ago === null ? "Conectando…" : ok ? "En vivo · actualizado hace " + ago + " s" : "Sin conexión · último dato hace " + ago + " s";
}, 1000);
setInterval(() => { if (!document.hidden) poll(); }, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
poll(true);
$("foot").textContent = "Se actualiza cada 4 segundos. Horas en " + CFG.timeZone + ". El costo es una estimación según los tokens usados.";
</script>
</body>
</html>`;
}
