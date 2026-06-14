import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import AskAI from "@/components/ai/ask-ai";

export default function Layout({ children }: LayoutProps<"/docs">) {
  // Server-side gate: only show the Ask-AI trigger when a key is configured.
  // Read at runtime (no NEXT_PUBLIC) so one image serves all environments.
  const aiEnabled = Boolean(process.env.OPENAI_API_KEY);

  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
      {aiEnabled ? <AskAI /> : null}
    </DocsLayout>
  );
}
