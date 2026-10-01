import pricingMarkdown from "./knowledge/pricing.md";
import calendarsJson from "./knowledge/calendars.json";

export interface BookingCalendar {
  id: string;
  name: string;
  durationMinutes: number;
  userId: string | null;
}

export const CALENDARS: BookingCalendar[] = calendarsJson;

/** Pricing reference split by top-level "## Category" headings. */
const PRICING_SECTIONS: Map<string, string> = (() => {
  const sections = new Map<string, string>();
  const parts = pricingMarkdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const title = part.slice(0, part.indexOf("\n")).trim();
    sections.set(title, `## ${part.trim()}`);
  }
  return sections;
})();

export const PRICING_CATEGORIES: string[] = [...PRICING_SECTIONS.keys()];

export function getPricing(category: string): string {
  const exact = PRICING_SECTIONS.get(category);
  if (exact) return exact;
  const wanted = category.toLowerCase();
  const match = PRICING_CATEGORIES.find((c) => c.toLowerCase() === wanted);
  if (match) return PRICING_SECTIONS.get(match)!;
  return `Unknown category "${category}". Valid categories: ${PRICING_CATEGORIES.join(" | ")}`;
}

/** Calendars whose name contains every keyword (case-insensitive). */
export function searchCalendars(keywords: string[]): BookingCalendar[] {
  const words = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  return CALENDARS.filter((c) => {
    const name = c.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

export function getCalendar(id: string): BookingCalendar | undefined {
  return CALENDARS.find((c) => c.id === id);
}
