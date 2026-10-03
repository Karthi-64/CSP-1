// Pure-JS hashing helpers. No models, no services — crypto.subtle + FNV-1a.

/** SHA-256 of raw bytes, lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const SIGN64 = 0x8000000000000000n;

/**
 * 64-bit FNV-1a hash of a shingle, returned as a signed-int8-safe decimal
 * string (Postgres `bigint` accepts the string and keeps full 64 bits).
 */
export function shingleHash64(shingle: string): string {
  // Hash the lowercase word-normalised form so casing/punctuation noise
  // does not fragment otherwise-identical content.
  const normalized = shingle.toLowerCase().replace(/\s+/g, " ").trim();
  let h = FNV_OFFSET;
  const enc = new TextEncoder().encode(normalized);
  for (const byte of enc) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  // Convert unsigned -> signed so the value fits PostgreSQL int8.
  if (h >= SIGN64) h -= 1n << 64n;
  return h.toString();
}
