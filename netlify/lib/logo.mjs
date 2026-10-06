export const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const LOGO_MAX_BYTES = 1.5 * 1024 * 1024;

export function parseLogo(value) {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return null;
  const match = value.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !LOGO_TYPES.has(match[1])) return { error: "Logo must be a PNG, JPG or WebP image." };
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > LOGO_MAX_BYTES) return { error: "Logo is too large — please use an image under 1.5 MB." };
  const matchesSignature = match[1] === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : match[1] === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!matchesSignature) return { error: "Logo must be a PNG, JPG or WebP image." };
  return { type: match[1], bytes };
}
