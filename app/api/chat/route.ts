import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { buildContextBlock, retrieveDocs } from "@/lib/ai/retrieval";
import {
  allowedOrigin,
  clientIp,
  rateLimit,
  MAX_MESSAGES,
  MAX_OUTPUT_TOKENS,
  MAX_TOTAL_CHARS,
} from "@/lib/ai/guards";

// Node runtime so process.env reads work and source.getPages() can read files.
export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You answer questions about the unerr docs.
Use ONLY the docs context provided below. Do not use outside knowledge.
Cite the page URLs you used. If the context does not cover the question,
reply exactly: "I don't know from the docs."`;

/** Pull the plain text out of a UI message's parts. */
function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ")
    .trim();
}

export async function POST(req: Request) {
  // Graceful fallback: no key means the chat is simply not available.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    return Response.json({ error: "ai_disabled" }, { status: 503 });
  }

  // Abuse/cost guards (see lib/ai/guards.ts). Cheap, in-memory, always on; the
  // durable cluster-wide limit lives at the ALB/WAF in aws-infra.
  if (!allowedOrigin(req)) {
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  }

  const limit = rateLimit(clientIp(req));
  if (!limit.ok) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let messages: UIMessage[];
  try {
    const body = (await req.json()) as { messages?: UIMessage[] };
    messages = Array.isArray(body.messages) ? body.messages : [];
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Reject oversized payloads before paying for a model call.
  const totalChars = messages.reduce((n, m) => n + textOf(m).length, 0);
  if (messages.length > MAX_MESSAGES || totalChars > MAX_TOTAL_CHARS) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = textOf(lastUser);

  const docs = question ? await retrieveDocs(question) : [];
  const context = buildContextBlock(docs);

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: openai(process.env.OPENAI_MODEL ?? DEFAULT_MODEL),
    system: `${SYSTEM_PROMPT}\n\n=== unerr docs context ===\n${context}`,
    messages: modelMessages,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Plain text stream so the client can read it with a ReadableStream reader,
  // no @ai-sdk/react dependency required.
  return result.toTextStreamResponse();
}
