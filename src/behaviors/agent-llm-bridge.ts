/**
 * Agent-as-LLM Bridge — BA-3.3
 *
 * Formalizes the sub-prompt injection pattern used throughout Layer 4.
 * Instead of managing API keys, unerr injects follow-up prompts that the
 * host agent (Claude/GPT) processes as part of its normal flow.
 *
 * Features:
 *   - Template system for common sub-prompt types
 *   - 5s timeout with graceful fallback to AST-only processing
 *   - Follow-through tracking: did the agent act on the injected prompt?
 *   - Prompt budgeting: limits injected context to prevent bloat
 */

export type PromptTemplate =
  | "session_resume"
  | "doc_generation"
  | "doc_update"
  | "loop_diagnosis"
  | "convention_fix"
  | "cascade_fix"
  | "architecture_alternative";

export interface SubPrompt {
  template: PromptTemplate;
  content: string;
  priority: "high" | "normal" | "low";
  maxTokens: number;
  timeoutMs: number;
  fallbackContent: string | null;
}

export interface PromptInjection {
  id: string;
  prompt: SubPrompt;
  injectedAt: number;
  followedThrough: boolean | null;
  responseDetectedAt: number | null;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PROMPT_TOKENS = 500;
const PROMPT_BUDGET_PER_CALL = 1000;

const TEMPLATE_DEFINITIONS: Record<
  PromptTemplate,
  {
    prefix: string;
    maxTokens: number;
    priority: "high" | "normal" | "low";
  }
> = {
  session_resume: {
    prefix:
      "Summarize the following session state for the developer in 2-3 natural sentences.",
    maxTokens: 300,
    priority: "normal",
  },
  doc_generation: {
    prefix: "Generate documentation following the existing style in this file.",
    maxTokens: 400,
    priority: "low",
  },
  doc_update: {
    prefix:
      "Update the documentation to reflect the following signature change.",
    maxTokens: 300,
    priority: "low",
  },
  loop_diagnosis: {
    prefix: "Analyze why the previous attempts failed before trying again.",
    maxTokens: 500,
    priority: "high",
  },
  convention_fix: {
    prefix: "Regenerate the code following the project's naming conventions.",
    maxTokens: 400,
    priority: "normal",
  },
  cascade_fix: {
    prefix:
      "Generate updated call sites for each caller with the new signature.",
    maxTokens: 500,
    priority: "high",
  },
  architecture_alternative: {
    prefix:
      "The following import crosses a module boundary. Suggest an alternative pattern.",
    maxTokens: 400,
    priority: "normal",
  },
};

let promptIdCounter = 0;

export class AgentLlmBridge {
  private injections: PromptInjection[] = [];
  private totalPromptTokensThisCall = 0;

  /**
   * Create a sub-prompt from a template with custom context.
   */
  createPrompt(
    template: PromptTemplate,
    context: string,
    options?: { timeoutMs?: number; fallback?: string }
  ): SubPrompt {
    const def = TEMPLATE_DEFINITIONS[template];

    const content = [def.prefix, "", context].join("\n");

    return {
      template,
      content: truncateToTokens(content, def.maxTokens),
      priority: def.priority,
      maxTokens: def.maxTokens,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fallbackContent: options?.fallback ?? null,
    };
  }

  /**
   * Inject a sub-prompt into the internal `context` carrier; surfaces as `ur|fct` prefix line on the response.
   * Returns the prompt content if within budget, or the fallback if over budget.
   */
  inject(prompt: SubPrompt): string {
    const estimatedTokens = estimateTokens(prompt.content);

    if (
      this.totalPromptTokensThisCall + estimatedTokens >
      PROMPT_BUDGET_PER_CALL
    ) {
      return prompt.fallbackContent ?? "";
    }

    this.totalPromptTokensThisCall += estimatedTokens;

    const injection: PromptInjection = {
      id: `prompt-${++promptIdCounter}`,
      prompt,
      injectedAt: Date.now(),
      followedThrough: null,
      responseDetectedAt: null,
    };

    this.injections.push(injection);
    return prompt.content;
  }

  /**
   * Record that the agent acted on an injected prompt.
   * Called when a subsequent tool call references the prompted action.
   */
  recordFollowThrough(promptId: string): void {
    const injection = this.injections.find((i) => i.id === promptId);
    if (injection) {
      injection.followedThrough = true;
      injection.responseDetectedAt = Date.now();
    }
  }

  /**
   * Reset per-call budget (call at the start of each tool call).
   */
  resetCallBudget(): void {
    this.totalPromptTokensThisCall = 0;
  }

  /**
   * Get follow-through rate: what % of injected prompts led to agent action.
   * Counts all injections (null = not followed through yet = counts as miss).
   */
  getFollowThroughRate(): number {
    if (this.injections.length === 0) return 0;
    const followed = this.injections.filter((i) => i.followedThrough === true);
    return followed.length / this.injections.length;
  }

  /**
   * Get the last injected prompt's ID (useful for follow-through recording).
   */
  getLastInjectionId(): string | null {
    if (this.injections.length === 0) return null;
    return this.injections[this.injections.length - 1]?.id ?? null;
  }

  getStats(): {
    totalInjected: number;
    followedThrough: number;
    followThroughRate: number;
    byTemplate: Record<string, number>;
  } {
    const byTemplate: Record<string, number> = {};
    let followedCount = 0;

    for (const injection of this.injections) {
      const key = injection.prompt.template;
      byTemplate[key] = (byTemplate[key] ?? 0) + 1;
      if (injection.followedThrough) followedCount++;
    }

    return {
      totalInjected: this.injections.length,
      followedThrough: followedCount,
      followThroughRate: this.getFollowThroughRate(),
      byTemplate,
    };
  }

  /**
   * Get all available template types.
   */
  static getTemplates(): PromptTemplate[] {
    return Object.keys(TEMPLATE_DEFINITIONS) as PromptTemplate[];
  }

  /**
   * Get template definition for a specific type.
   */
  static getTemplateDefinition(template: PromptTemplate): {
    prefix: string;
    maxTokens: number;
    priority: "high" | "normal" | "low";
  } {
    return { ...TEMPLATE_DEFINITIONS[template] };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}
