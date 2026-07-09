/** Splits a comma- or whitespace-separated value (a flag or env var) into
 * non-empty entries, preserving case so command names stay exact. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

/** Reads a trimmed, non-empty env var when env permission is already granted;
 * returns undefined otherwise, without triggering a permission prompt. */
export function envValue(variable: string): string | undefined {
  const { state } = Deno.permissions.querySync({ name: "env", variable });
  if (state !== "granted") return undefined;
  const value = Deno.env.get(variable)?.trim();
  return value ? value : undefined;
}
