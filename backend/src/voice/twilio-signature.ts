import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs every webhook it sends: base64(HMAC-SHA1(auth token, URL +
 * every POST parameter, key then value, in key order)). The URL is the one
 * Twilio was told to call — scheme, host, path and query — so it is rebuilt
 * from `PUBLIC_API_URL` rather than read off a request that a proxy may have
 * rewritten (D-144).
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | undefined>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ""), url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function twilioSignatureValid(
  authToken: string,
  url: string,
  params: Record<string, string | undefined>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
