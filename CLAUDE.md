# HED AI Agent (Julia)

SMS/Instagram sales agent for High End Detail on GoHighLevel. Cloudflare Worker + Claude API. The owner (Josue) prefers English; reply to him in English.

## Where things live

- `src/prompt.ts`: Julia's system prompt: tone, rules, NEPQ modules, booking flow, hours, address. Most "change what the agent says or does" requests are edits here.
- `src/knowledge/pricing.md`: service prices and "what's included" (exported from Square). Price changes go here; keep the table format and `## Category` headings, since `get_pricing` splits on them.
- `src/knowledge/calendars.json`: active GHL service calendars (`id`, `name`, `durationMinutes`, `userId`, `priceCents` and `squareVariationId` from the Square catalog). Regenerate from `GET /calendars/` (active, `calendarType = service_booking`) when calendars are added or renamed.
- `src/agent.ts`: Claude tool loop and tools (pricing, calendars, slots, booking, phone, buying intent, escalation). Tool descriptions live here too.
- `src/index.ts`: GHL webhook, Square payment webhook (`/webhook/square`), per-contact Durable Object (debounce, tag gating, human-reply pause), `/simulate`, `/diag`.
- `src/events.ts` + `src/dashboard.ts`: activity log (`EventLog` Durable Object, SQLite) and the live dashboard at `/` (password login with `DASHBOARD_KEY`, cookie session; polls `/api/events`). Health check is `/health`.
- `src/followups.ts`: follow-up cadence and send window. The per-contact Durable Object in `src/index.ts` runs them (one alarm for both the debounced reply and the next follow-up); Julia's follow-up rules are the FOLLOW-UPS section of `src/prompt.ts`. Switches: `FOLLOWUPS` (`on` / `draft` / `off`), `FOLLOWUP_SCHEDULE`, `FOLLOWUP_HOURS`, `FOLLOWUP_OPTOUT_TAG`.
- `src/square.ts`: Square deposit payment links and webhook signature check. Deposit = `DEPOSIT_PERCENT` of the booked calendars' `priceCents`.
- `wrangler.toml` `[vars]`: rollout switches (`ONLY_TAG`, `DRY_RUN`, model, effort, tags, delays). Secrets (`ANTHROPIC_API_KEY`, `GHL_TOKEN`, `WEBHOOK_SECRET`, `SQUARE_ACCESS_TOKEN`, `SQUARE_WEBHOOK_SIGNATURE_KEY`) live only in Cloudflare.

## Deploying

Cloudflare Workers Builds deploys automatically on every push to `claude/gohighlevel-sms-instagram-agent-a6m4kf` (the repo's default branch). Commit changes and push to that branch, unless the owner asks for a separate branch or PR to review first. Run `npm run typecheck` before pushing.

## House rules for the prompt

- No long dashes ("—") in anything sent to customers.
- Never write "following up", "checking in", "checking back", "touching base" or "circling back" to a customer (Claude and Julia). It reads as desperate. Open with their vehicle, their problem or one useful question.
- Never invent prices; every price, duration and package name comes from `get_pricing`.
- The only booking link is the service-menu link in `BOOKING_LINK`.
- Never confirm an appointment unless `book_appointment` returned "Booked."

## GHL contacts and estimates

- Never put a vehicle (make, model, color) in a contact's first or last name. GHL templates greet customers by first name ("Hi Porsche"). If the name is unknown, leave the name empty and put the vehicle in a tag or note. Estimates require a customer name: use the phone number, e.g. "(305) 297-9075".
- Every estimate or invoice (GHL or Square) carries our branding: always set `businessDetails.logoUrl` to the logo in GHL invoice settings (`get-invoice-settings` → `businessDetails.logoUrl`) plus the website https://highenddetail.com/. Never send one without the logo.
- Greeting a customer whose name you don't know (Claude and Julia alike): just "Hi" and the message. Never use the car, a placeholder or the phone number as a name in what the customer reads.
