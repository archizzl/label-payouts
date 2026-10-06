import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/*
 * Encryption for secrets stored in the database (e.g. an account's Bandcamp API client secret), so a
 * database leak alone doesn't expose them. The key comes from APP_ENCRYPTION_KEY.
 */

function key() {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (!k) throw new Error("APP_ENCRYPTION_KEY isn't set, so secrets can't be stored.");
  return createHash("sha256").update(k).digest(); // any string → 32 bytes
}

/** AES-256-GCM; returns "v1:iv:tag:ciphertext" in base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((x) => (typeof x === "string" ? x : x.toString("base64"))).join(":");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/**
 * A fingerprint of an email address: the same address always gives the same fingerprint, but the
 * address can't be read back from it. Lets a fan on the mailing list be matched to their purchases
 * without storing every buyer's email. Keyed (HMAC), so it can't be reversed by guessing addresses
 * without APP_ENCRYPTION_KEY.
 */
export function emailFingerprint(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return null;
  return createHmac("sha256", key()).update(`email:${e}`).digest("base64url").slice(0, 32);
}
