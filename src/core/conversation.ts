/**
 * Conversation Manager — in-memory conversation history with optional persistence.
 *
 * Manages the message list for the interactive REPL session.
 * Supports context window management (truncation when approaching limits).
 */

import type { ConversationMessage } from "./query-engine.js";

export interface ConversationOptions {
  /** Maximum messages to keep in history (FIFO eviction). Default: 100 */
  maxMessages?: number;
}

export class Conversation {
  private messages: ConversationMessage[] = [];
  private readonly maxMessages: number;

  constructor(opts: ConversationOptions = {}) {
    this.maxMessages = opts.maxMessages ?? 100;
  }

  /** Add a message to the conversation. */
  add(message: ConversationMessage): void {
    this.messages.push(message);
    // Evict oldest messages (always keep at least the last user message)
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
  }

  /** Get all messages in chronological order. */
  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  /** Clear conversation history. */
  clear(): void {
    this.messages = [];
  }

  /** Get the number of messages. */
  get length(): number {
    return this.messages.length;
  }
}
