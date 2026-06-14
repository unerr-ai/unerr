"use client";

import { useCallback, useRef, useState } from "react";

/**
 * "Ask AI" trigger + chat panel for the docs. Talks to /api/chat and streams
 * the reply as plain text, so it needs no AI SDK React hook. Shows a short
 * notice instead of a reply when the endpoint is unconfigured (503) or the
 * caller is rate-limited (429).
 *
 * @sem domain=docs-ai role=ui
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `m${idCounter}`;
}

/** Shape /api/chat expects: AI SDK v6 UI messages. */
function toUIMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text", text: m.text }],
  }));
}

export default function AskAI() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<
    "idle" | "streaming" | "disabled" | "error" | "rate_limited"
  >("idle");
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || status === "streaming") return;

    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      text: question,
    };
    const assistantId = nextId();
    const outgoing = [...messages, userMessage];

    setMessages([
      ...outgoing,
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setInput("");
    setStatus("streaming");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: toUIMessages(outgoing) }),
        signal: controller.signal,
      });

      if (res.status === 503) {
        setStatus("disabled");
        setMessages(outgoing);
        return;
      }
      if (res.status === 429) {
        setStatus("rate_limited");
        setMessages(outgoing);
        return;
      }
      if (!res.ok || !res.body) {
        setStatus("error");
        setMessages(outgoing);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text: acc } : m)),
        );
      }
      setStatus("idle");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        setStatus("idle");
        return;
      }
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }, [input, messages, status]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-fd-border bg-fd-card px-3 py-1.5 text-sm text-fd-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
      >
        Ask AI
      </button>

      {open ? (
        <div className="fixed bottom-4 right-4 z-50 flex h-[28rem] w-[22rem] flex-col overflow-hidden rounded-lg border border-fd-border bg-fd-card text-fd-foreground shadow-lg">
          <div className="flex items-center justify-between border-b border-fd-border px-3 py-2">
            <span className="text-sm font-medium">Ask AI</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded p-1 text-fd-muted-foreground hover:text-fd-foreground"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
            {messages.length === 0 && status !== "disabled" ? (
              <p className="text-fd-muted-foreground">
                Ask a question about the docs. Answers come from the docs pages.
              </p>
            ) : null}

            {status === "disabled" ? (
              <p className="text-fd-muted-foreground">
                AI search isn&apos;t configured.
              </p>
            ) : null}

            {messages.map((m) => (
              <div
                key={m.id}
                className={m.role === "user" ? "text-right" : "text-left"}
              >
                <span
                  className={
                    m.role === "user"
                      ? "inline-block rounded-md bg-fd-primary px-3 py-1.5 text-fd-primary-foreground"
                      : "inline-block whitespace-pre-wrap rounded-md bg-fd-secondary px-3 py-1.5 text-fd-secondary-foreground"
                  }
                >
                  {m.text ||
                    (m.role === "assistant" && status === "streaming"
                      ? "…"
                      : "")}
                </span>
              </div>
            ))}

            {status === "rate_limited" ? (
              <p className="text-fd-muted-foreground">
                Too many questions just now. Wait a moment and try again.
              </p>
            ) : null}

            {status === "error" ? (
              <p className="text-fd-muted-foreground">
                Something went wrong. Try again.
              </p>
            ) : null}
          </div>

          <div className="border-t border-fd-border p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about the docs…"
              className="w-full rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm text-fd-foreground outline-none focus:border-fd-ring"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
