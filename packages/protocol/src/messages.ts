export type ServerEvent =
  | { type: "open"; secret: string }
  | { type: "up_open" }
  | { type: "msg"; data: string }
  | { type: "up_close"; code: number; reason: string };

export type ClientSend = { data: string };

export type ClientClose = { code?: number; reason?: string };

const SERVER_EVENT_TYPES = new Set(["open", "up_open", "msg", "up_close"]);

export function encodeServerEvent(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function parseServerEvent(data: string): ServerEvent {
  const parsed = JSON.parse(data) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type: unknown }).type !== "string" ||
    !SERVER_EVENT_TYPES.has((parsed as { type: string }).type)
  ) {
    throw new Error(`Invalid server event: ${data}`);
  }
  return parsed as ServerEvent;
}

export function parseClientSend(body: unknown): ClientSend {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { data: unknown }).data !== "string"
  ) {
    throw new Error("Invalid client send payload");
  }
  return { data: (body as { data: string }).data };
}
