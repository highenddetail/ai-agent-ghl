// Minimal GoHighLevel (LeadConnector) API v2 client for the endpoints the agent uses.

const BASE_URL = "https://services.leadconnectorhq.com";

export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  tags?: string[];
}

export interface GhlMessage {
  id: string;
  direction: "inbound" | "outbound";
  body?: string;
  messageType?: string; // TYPE_SMS, TYPE_INSTAGRAM, ...
  dateAdded: string;
  source?: string; // "app" = typed by a team member in GHL
  userId?: string;
  contentType?: string;
}

export interface GhlConversation {
  id: string;
  contactId: string;
  lastMessageType?: string;
}

export interface GhlAppointment {
  id: string;
  calendarId: string;
  title?: string;
  startTime: string;
  endTime: string;
  appointmentStatus?: string;
  deleted?: boolean;
}

export type FreeSlots = Record<string, { slots: string[] }>;

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class GhlClient {
  constructor(
    private readonly token: string,
    readonly locationId: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { version?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: opts.version ?? "2021-07-28",
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GhlError(`GHL ${method} ${path} failed with ${res.status}`, res.status, text.slice(0, 500));
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getContact(contactId: string): Promise<GhlContact> {
    const data = await this.request<{ contact: GhlContact }>("GET", `/contacts/${contactId}`);
    return data.contact;
  }

  async updateContact(contactId: string, fields: { phone?: string }): Promise<void> {
    await this.request("PUT", `/contacts/${contactId}`, { body: fields });
  }

  /** Times come back as "YYYY-MM-DD HH:mm:ss" in the location's timezone. */
  async getContactAppointments(contactId: string): Promise<GhlAppointment[]> {
    const data = await this.request<{ events: GhlAppointment[] }>("GET", `/contacts/${contactId}/appointments`);
    return data.events ?? [];
  }

  async updateAppointment(
    appointmentId: string,
    fields: { appointmentStatus?: string; startTime?: string; endTime?: string; calendarId?: string },
  ): Promise<void> {
    await this.request("PUT", `/calendars/events/appointments/${appointmentId}`, { version: "2021-04-15", body: fields });
  }

  async removeTags(contactId: string, tags: string[]): Promise<void> {
    await this.request("DELETE", `/contacts/${contactId}/tags`, { body: { tags } });
  }

  async addTags(contactId: string, tags: string[]): Promise<void> {
    await this.request("POST", `/contacts/${contactId}/tags`, { body: { tags } });
  }

  async addNote(contactId: string, body: string): Promise<void> {
    await this.request("POST", `/contacts/${contactId}/notes`, { body: { body } });
  }

  async findConversation(contactId: string): Promise<GhlConversation | undefined> {
    const data = await this.request<{ conversations: GhlConversation[] }>("GET", "/conversations/search", {
      version: "2021-04-15",
      query: { locationId: this.locationId, contactId, limit: 1, sort: "desc", sortBy: "last_message_date" },
    });
    return data.conversations[0];
  }

  /** Most recent messages, newest first. */
  async getMessages(conversationId: string, limit = 40): Promise<GhlMessage[]> {
    const data = await this.request<{ messages: { messages: GhlMessage[] } }>(
      "GET",
      `/conversations/${conversationId}/messages`,
      { version: "2021-04-15", query: { limit } },
    );
    return data.messages.messages;
  }

  async sendMessage(contactId: string, type: "SMS" | "IG", message: string): Promise<string | undefined> {
    const data = await this.request<{ messageId?: string }>("POST", "/conversations/messages", {
      version: "2021-04-15",
      body: { type, contactId, message },
    });
    return data.messageId;
  }

  async getFreeSlots(calendarId: string, startMs: number, endMs: number, timezone: string): Promise<FreeSlots> {
    const data = await this.request<Record<string, unknown>>("GET", `/calendars/${calendarId}/free-slots`, {
      version: "2021-04-15",
      query: { startDate: startMs, endDate: endMs, timezone },
    });
    const slots: FreeSlots = {};
    for (const [key, value] of Object.entries(data)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && value && typeof value === "object" && "slots" in value) {
        slots[key] = value as { slots: string[] };
      }
    }
    return slots;
  }

  async createAppointment(input: {
    calendarId: string;
    contactId: string;
    startTime: string;
    endTime: string;
    assignedUserId?: string | null;
    title: string;
    description?: string;
  }): Promise<{ id: string; startTime: string; endTime: string }> {
    return this.request("POST", "/calendars/events/appointments", {
      version: "2021-04-15",
      body: {
        locationId: this.locationId,
        calendarId: input.calendarId,
        contactId: input.contactId,
        startTime: input.startTime,
        endTime: input.endTime,
        title: input.title,
        description: input.description,
        appointmentStatus: "confirmed",
        toNotify: true,
        ...(input.assignedUserId ? { assignedUserId: input.assignedUserId } : {}),
      },
    });
  }
}
