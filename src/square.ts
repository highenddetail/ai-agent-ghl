// Minimal Square client: deposit payment links and webhook signature checks.

const BASE_URL = "https://connect.squareup.com/v2";

/** Marker put in the payment note so the payment webhook can find the contact again. */
export const NOTE_MARKER = "HED-AI";

export interface DepositNote {
  contactId: string;
  appointmentIds: string[];
  channel: "SMS" | "IG";
  language: "en" | "es";
}

export function encodeDepositNote(n: DepositNote, label: string): string {
  return `${label} | ${NOTE_MARKER}|c:${n.contactId}|a:${n.appointmentIds.join(",")}|ch:${n.channel}|l:${n.language}`;
}

export function decodeDepositNote(note: string | undefined): DepositNote | undefined {
  const m = /HED-AI\|c:([^|]+)\|a:([^|]*)\|ch:(SMS|IG)\|l:(en|es)/.exec(note ?? "");
  if (!m) return undefined;
  return { contactId: m[1], appointmentIds: m[2].split(",").filter(Boolean), channel: m[3] as "SMS" | "IG", language: m[4] as "en" | "es" };
}

export class SquareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class SquareClient {
  constructor(
    private readonly token: string,
    private readonly locationId: string,
  ) {}

  async createPaymentLink(input: {
    name: string;
    amountCents: number;
    note: string;
    idempotencyKey: string;
    buyerPhone?: string;
    buyerEmail?: string;
  }): Promise<{ id: string; url: string; orderId: string }> {
    const prePopulated: Record<string, string> = {};
    if (input.buyerPhone) prePopulated.buyer_phone_number = input.buyerPhone;
    if (input.buyerEmail) prePopulated.buyer_email = input.buyerEmail;
    const res = await fetch(`${BASE_URL}/online-checkout/payment-links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: input.idempotencyKey.slice(0, 192),
        quick_pay: {
          name: input.name.slice(0, 255),
          price_money: { amount: input.amountCents, currency: "USD" },
          location_id: this.locationId,
        },
        payment_note: input.note.slice(0, 500),
        ...(Object.keys(prePopulated).length ? { pre_populated_data: prePopulated } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new SquareError(`Square payment link failed with ${res.status}`, res.status, text.slice(0, 500));
    const link = (JSON.parse(text) as { payment_link: { id: string; url: string; order_id: string } }).payment_link;
    return { id: link.id, url: link.url, orderId: link.order_id };
  }
}

/** Square signs `notificationUrl + rawBody` with HMAC-SHA256 (base64) using the subscription's signature key. */
export async function verifySquareSignature(
  rawBody: string,
  signature: string | null,
  notificationUrl: string,
  signatureKey: string,
): Promise<boolean> {
  if (!signature || !signatureKey) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signatureKey), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(notificationUrl + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
