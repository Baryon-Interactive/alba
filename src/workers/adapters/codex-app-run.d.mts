export interface AppEventTranslator {
  markTurnStarted(turnId?: string | null): Record<string, unknown> | null;
  translate(msg: Record<string, unknown>): Record<string, unknown>[];
}

export function createAppEventTranslator(): AppEventTranslator;
export function convertAppItem(raw: unknown): Record<string, unknown> | null;
export function parseInboxText(text: string): { id: string; at: string; author: string; text: string; reply?: string; seen?: string }[];
export function frameMessages(messages: readonly { id: string; at: string; author: string; text: string }[], maxBytes?: number): string;
export function runCodexApp(spec: Record<string, unknown>): Promise<number>;
