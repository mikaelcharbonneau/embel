/** Stable JSON for hashes shared by browser diagnostics and server inspection. */
export function canonicalIdentityInput(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalIdentityInput).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalIdentityInput((value as Record<string, unknown>)[key]))
        .join(",") +
      "}"
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Identity checks require JSON values.");
  return result;
}
async function hashIdentityText(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}
export function hashIdentityInput(value: unknown): Promise<string> {
  return hashIdentityText(canonicalIdentityInput(value));
}
export async function fontCheckBinding(input: {
  text: string;
  fontVersionId: string;
  fontContentHash: string;
  weight: number;
  style: "normal" | "italic";
}): Promise<{ sampleHash: string; styleHash: string }> {
  return {
    sampleHash: await hashIdentityText(input.text),
    styleHash: await hashIdentityInput({
      version: 1,
      fontVersionId: input.fontVersionId,
      fontContentHash: input.fontContentHash,
      weight: input.weight,
      style: input.style,
    }),
  };
}
