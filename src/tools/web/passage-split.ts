/**
 * Split extracted markdown into passages for pagination + BM25 ranking.
 *
 * A passage is a heading section OR a block of consecutive non-empty lines
 * separated by blank lines. Code fences are kept whole. Each passage carries
 * its heading path so the agent can locate it without re-fetching.
 */

export interface Passage {
  index: number;
  heading: string | null;
  text: string;
  startLine: number;
}

export function splitMarkdownIntoPassages(markdown: string): Passage[] {
  const lines = markdown.split("\n");
  const passages: Passage[] = [];

  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let bufferStart = 0;
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      passages.push({
        index: passages.length,
        heading: currentHeading,
        text,
        startLine: bufferStart + 1,
      });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(/^(```|~~~)/);

    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1] ?? "```";
        if (buffer.length === 0) bufferStart = i;
        buffer.push(line);
      } else if (line.startsWith(fenceMarker)) {
        buffer.push(line);
        inFence = false;
      } else {
        buffer.push(line);
      }
      continue;
    }

    if (inFence) {
      buffer.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2] ?? null;
      bufferStart = i;
      buffer.push(line);
      continue;
    }

    if (line.trim() === "") {
      if (buffer.length > 0) flush();
      continue;
    }

    if (buffer.length === 0) bufferStart = i;
    buffer.push(line);
  }
  flush();

  return passages;
}
