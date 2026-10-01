# HED AI Agent (Julia)

SMS/Instagram sales agent for High End Detail on GoHighLevel. Cloudflare Worker + Claude API. The owner (Josue) writes in Spanish; reply in Spanish.

## Where things live

- `src/prompt.ts`: Julia's system prompt: tone, rules, NEPQ modules, booking flow, hours, address. Most "change what the agent says or does" requests are edits here.
- `src/knowledge/pricing.md`: service prices and "what's included" (exported from Square). Price changes go here; keep the table format and `## Category` headings, since `get_pricing` splits on them.
- `src/knowledge/calendars.json`: active GHL service calendars (`id`, `name`, `durationMinutes`, `userId`). Regenerate from `GET /calendars/` (active, `calendarType = service_booking`) when calendars are added or renamed.
- `src/agent.ts`: Claude tool loop and tools (pricing, calendars, slots, booking, phone, buying intent, escalation). Tool descriptions live here too.
- `src/index.ts`: webhook endpoint, per-contact Durable Object (debounce, tag gating, human-reply pause), `/simulate`.
- `wrangler.toml` `[vars]`: rollout switches (`ONLY_TAG`, `DRY_RUN`, model, effort, tags, delays). Secrets (`ANTHROPIC_API_KEY`, `GHL_TOKEN`, `WEBHOOK_SECRET`) live only in Cloudflare.

## Deploying

Cloudflare Workers Builds deploys automatically on every push to `claude/gohighlevel-sms-instagram-agent-a6m4kf` (the repo's default branch). Commit changes and push to that branch, unless the owner asks for a separate branch or PR to review first. Run `npm run typecheck` before pushing.

## House rules for the prompt

- No long dashes ("—") in anything sent to customers.
- Never invent prices; every price, duration and package name comes from `get_pricing`.
- The only booking link is the service-menu link in `BOOKING_LINK`.
- Never confirm an appointment unless `book_appointment` returned "Booked."
