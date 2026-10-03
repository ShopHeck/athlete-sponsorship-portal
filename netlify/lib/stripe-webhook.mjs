import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyStripeSignature(rawBody, header, secrets, { toleranceSec = 300, now = Date.now() } = {}) {
  if (typeof rawBody !== "string" || typeof header !== "string") return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))
    .filter((signature) => /^[a-f0-9]{64}$/i.test(signature));
  if (!timestamp || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSec) return false;

  const configuredSecrets = Array.isArray(secrets) ? secrets.filter((secret) => typeof secret === "string" && secret.length > 0) : [];
  const signedPayload = `${timestamp}.${rawBody}`;
  let valid = false;
  for (const secret of configuredSecrets) {
    const expected = createHmac("sha256", secret).update(signedPayload).digest();
    for (const signature of signatures) {
      const actual = Buffer.from(signature, "hex");
      if (actual.length === expected.length) valid = timingSafeEqual(expected, actual) || valid;
    }
  }
  return valid;
}
