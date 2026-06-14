"use client";

import { useEffect, useId, useState } from "react";

/** Reads the current docs theme from the `dark` class Fumadocs sets on <html>. */
function useIsDark() {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setIsDark(root.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

/**
 * Renders a Mermaid diagram from a `chart` string. Mermaid is loaded lazily on
 * the client so it never enters the server bundle, and the diagram re-renders
 * when the docs theme toggles between dark and light.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState("");
  const isDark = useIsDark();

  useEffect(() => {
    let active = true;

    async function render() {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: isDark ? "dark" : "default",
        fontFamily: "inherit",
      });

      try {
        const result = await mermaid.render(
          `mermaid-${id.replace(/[^a-zA-Z0-9]/g, "")}`,
          chart,
        );
        if (active) setSvg(result.svg);
      } catch (error) {
        console.error("Mermaid render failed", error);
      }
    }

    void render();
    return () => {
      active = false;
    };
  }, [chart, id, isDark]);

  return (
    <div
      className="my-6 flex justify-center [&_svg]:max-w-full"
      // mermaid output is generated from trusted, in-repo chart strings
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
