import { join } from "node:path";
import { materializeTranscripts } from "../src/tracking/transcript-materializer.js";
const repoCwd = process.cwd();
const n = await materializeTranscripts({
  repoCwd,
  unerrDir: join(repoCwd, ".unerr"),
  agent: "claude-code",
  sessionId: "verify-transcript-live",
});
console.error("materializeTranscripts turns enqueued:", n);
