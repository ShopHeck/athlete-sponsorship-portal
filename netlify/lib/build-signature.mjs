import { createHmac, timingSafeEqual } from "node:crypto";

export function hasValidBuildSignature(body, signature, secret = process.env.DASHBOARD_SECRET) {
  if (!secret || typeof body?.slug !== "string" || typeof body?.jobId !== "string" ||
      !/^[a-f0-9]{64}$/i.test(signature || "")) return false;
  const expected = createHmac("sha256", secret).update(`${body.slug}.${body.jobId}`).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
