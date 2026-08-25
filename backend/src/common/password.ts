import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing on Node's standard library.
 *
 * scrypt is memory-hard, so a GPU cannot parallelise an attack the way it can
 * against a plain hash, and it ships with Node — no native build step, which
 * matters on a Windows machine with no compiler toolchain.
 */

const KEY_LENGTH = 64;
const PARAMS: Required<Pick<ScryptOptions, "N" | "r" | "p">> = { N: 16384, r: 8, p: 1 };

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, PARAMS);

  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Compares in constant time. A plain `===` leaks how many leading bytes matched
 * through its return timing, which is enough to reconstruct a hash byte by byte.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");

  const candidate = await derive(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
