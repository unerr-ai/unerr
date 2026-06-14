import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Built-in static/server search (Orama). No external service.
export const { GET } = createFromSource(source, {
  // https://docs.orama.com/docs/orama-js/supported-languages
  language: "english",
});
