# HED AI Agent (Julia) para GoHighLevel

Agente de ventas de High End Detail que responde los SMS y DMs de Instagram en GoHighLevel con Claude.
Da precios exactos del catálogo de servicios, sigue el método NEPQ y **agenda directamente** en los calendarios de GHL cuando el cliente confirma día y hora.

Corre en **Cloudflare Workers** (plan gratis) usando Durable Objects.

## Cómo funciona

```
Cliente escribe (SMS / IG)
   └─> Workflow de GHL "Customer Replied" ──webhook──> Cloudflare Worker /webhook/ghl
          └─> Durable Object por contacto (espera 7 s por si manda varios mensajes seguidos)
                 ├─ revisa tags (ai-agent, stop bot, ai-escalated) y si un humano respondió hace poco
                 ├─ lee los últimos 40 mensajes de la conversación en GHL
                 ├─ Claude (Julia) decide la respuesta usando herramientas:
                 │     get_pricing · find_booking_calendar · get_available_slots
                 │     book_appointment · mark_buying_intent · escalate_to_human
                 └─ envía la respuesta por el mismo canal (o la deja como nota si DRY_RUN=true)
```

- **Precios**: `src/knowledge/pricing.md` (exportado de Square el 16 de agosto de 2026).
- **Calendarios**: `src/knowledge/calendars.json` (133 calendarios de servicio activos en GHL, con duración y miembro del equipo asignado).
- **Intención de compra**: cuando el cliente muestra intención real de avanzar, se agrega el tag `ai-buying-intent` y una nota. Puedes crear un workflow en GHL con ese tag para avisarle al equipo.
- **Escalamiento a humano**: si hay negociación de precio, una queja, el cliente pide hablar con una persona, quiere cancelar o reprogramar, o hace una pregunta técnica que no está en el catálogo, se agrega el tag `ai-escalated` y una nota. El bot deja de responder a ese contacto hasta que quites el tag.
- **Si un humano responde** manualmente desde GHL, el bot se queda callado en ese contacto por 5 minutos (`HUMAN_PAUSE_MINUTES`).
- El tag `stop bot`, que ya usan, también detiene al agente.

## Depósitos con Square

Primero se paga, después se agenda. Cuando el cliente confirma día y hora, Julia manda un link de pago de Square por el **10%** (`DEPOSIT_PERCENT`) del precio de catálogo de los servicios elegidos. Los precios salen de `priceCents` en `src/knowledge/calendars.json`, tomados del catálogo de Square. Los servicios de cotización personalizada no llevan depósito y se agendan directo.

- Al enviar el link: tag `deposito-pendiente` y una nota con el monto y el link. La cita todavía no existe.
- Cuando el cliente paga, Square avisa a `/webhook/square`. El Worker verifica la firma, crea la(s) cita(s) en el horario elegido, cambia el tag a `deposito-pagado`, deja una nota con el ID del pago y le confirma la cita al cliente por el mismo canal.
- Si ese horario se ocupó mientras pagaba, el depósito queda como crédito: Julia le pide otro horario y lo agenda sin cobrar de nuevo.

Configuración en Square (developer.squareup.com → tu app → Production):
1. **Credentials → Access token**: guárdalo en Cloudflare como Secret `SQUARE_ACCESS_TOKEN`.
2. **Webhooks → Add subscription**: URL `https://<tu-worker>.workers.dev/webhook/square`, evento `payment.updated`. Copia la **Signature key** y guárdala en Cloudflare como Secret `SQUARE_WEBHOOK_SIGNATURE_KEY`.

## Instalación

### 1. Token de GoHighLevel (Private Integration)

En GHL ve a **Settings → Private Integrations → Create new integration** y dale estos permisos:

- `contacts.readonly`, `contacts.write`
- `conversations.readonly`, `conversations.write`
- `conversations/message.readonly`, `conversations/message.write`
- `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`

Copia el token (`pit-...`).

### 2. API key de Claude

En https://platform.claude.com crea una API key y carga créditos.

### 3. Desplegar en Cloudflare

```bash
npm install
npx wrangler login                          # abre el navegador para entrar a tu cuenta de Cloudflare (gratis)
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GHL_TOKEN
npx wrangler secret put WEBHOOK_SECRET      # inventa una clave larga, por ejemplo con: openssl rand -hex 24
npx wrangler deploy
```

Al terminar te da una URL como `https://hed-ai-agent.<tu-subdominio>.workers.dev`.

### 4. Workflow en GoHighLevel

**Automation → Workflows → Create workflow**:

1. **Trigger:** *Customer Replied*, con filtro *Reply channel* = SMS e Instagram.
2. **Action:** *Webhook* (o *Custom Webhook*)
   - Method: `POST`
   - URL: `https://hed-ai-agent.<tu-subdominio>.workers.dev/webhook/ghl?key=<WEBHOOK_SECRET>`
   - Custom data: `contact_id` = `{{contact.id}}`
3. Activa la opción *Allow re-entry* para que dispare con cada mensaje.
4. Publica el workflow.

> Importante: apaga el bot actual de Conversation AI (Julia) en SMS e Instagram, o por lo menos para los contactos con el tag `ai-agent`, para que no respondan dos bots.

### 5. Lanzamiento por etapas

| Etapa | `ONLY_TAG` | `DRY_RUN` | Qué pasa |
|---|---|---|---|
| 1. Borradores | `ai-agent` | `true` | Solo en contactos con el tag `ai-agent`. La respuesta queda como **nota** en el contacto y no se envía. Sirve para revisar el tono. |
| 2. Piloto | `ai-agent` | `false` | Responde de verdad, pero solo a contactos con el tag `ai-agent`. |
| 3. Todos | `""` | `false` | Responde todos los SMS y DMs de Instagram, salvo los contactos con `stop bot` o `ai-escalated`. |

Estas variables se cambian en `wrangler.toml` (sección `[vars]`) y luego se vuelve a correr `npx wrangler deploy`.

## Probar sin GHL

```bash
cp .dev.vars.example .dev.vars   # y llena las claves
npm run dev
curl -X POST "http://localhost:8787/simulate?key=<WEBHOOK_SECRET>" \
  -H "content-type: application/json" \
  -d '{"channel":"SMS","messages":[{"from":"customer","text":"cuanto cuesta polarizar un camry 2022?"}]}'
```

`/simulate` sí consulta los horarios reales de GHL, pero **no** crea citas, no pone tags y no envía mensajes.

Para ver los logs en vivo: `npm run tail`.

## Configuración (`wrangler.toml`)

| Variable | Default | Descripción |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Modelo de Claude. `claude-opus-5-5` razona más pero cuesta el doble y es más lento. |
| `CLAUDE_EFFORT` | `low` | `low` / `medium` / `high`. Más alto = más razonamiento y más costo. |
| `BOOKING_LINK` | service menu de HED | El único link de agendamiento que puede enviar el agente (respaldo si no logra agendar directo). |
| `ONLY_TAG` | `ai-agent` | Si tiene valor, solo responde a contactos con ese tag. |
| `DRY_RUN` | `false` | `true` = deja la respuesta como nota sin enviarla. |
| `STOP_TAGS` | `stop bot,ai-escalated` | Contactos con estos tags nunca reciben respuesta automática. |
| `DEBOUNCE_SECONDS` | `7` | Espera tras el último mensaje del cliente antes de responder. |
| `HUMAN_PAUSE_MINUTES` | `5` | Minutos de silencio después de que alguien del equipo responde manualmente. |
| `CHANGE_NOTICE_HOURS` | `24` | Aviso mínimo para que Julia cancele o reprograme sola; con menos tiempo pasa el caso al equipo. |

## Costos

- **Cloudflare:** gratis (100,000 requests al día). Si en los logs aparece un error de límite de CPU, el plan Workers Paid cuesta USD 5 al mes.
- **Claude API:** aproximadamente USD 0.015 a 0.05 por respuesta con Sonnet 5.5 en effort `low` (depende de cuántas herramientas use: precios, horarios, reserva). Con `claude-opus-5-5` es más o menos el doble.

## Mantenimiento

- **Precios cambiaron:** actualiza `src/knowledge/pricing.md` y vuelve a desplegar.
- **Calendarios nuevos o renombrados en GHL:** regenera `src/knowledge/calendars.json` con la lista de calendarios (`GET /calendars/`): solo los que tienen `calendarType = service_booking` y están activos, con `id`, `name`, `durationMinutes` y `userId` del miembro principal del equipo.
- **Ajustar el tono o las reglas:** edita `src/prompt.ts`.
