/**
 * Serialize an unknown caught value into a stable, human-readable string.
 *
 * Why: `String(obj)` returns `"[object Object]"` for plain objects (e.g.,
 * cozo-node driver errors that aren't Error instances), which is useless in
 * logs. `JSON.stringify(obj)` returns `"{}"` when an object's properties
 * are non-enumerable. This helper handles all three shapes deterministically.
 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.display === "string") return obj.display;
    if (typeof obj.message === "string") return obj.message;
    try {
      const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // fall through
    }
    return Object.prototype.toString.call(err);
  }
  return String(err);
}
