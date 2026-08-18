/** Narrow a successful rotation/recover response to its new_session_id.
 * Call AFTER asserting ok — the assert stays first in the test's reading
 * order; this helper only narrows (and labels the impossible shape). */
export function newSessionIdOf(resp: unknown): string {
  const id = (resp as { result?: { new_session_id?: unknown } }).result?.new_session_id;
  if (typeof id !== "string") {
    throw new TypeError("response carries no result.new_session_id");
  }
  return id;
}
