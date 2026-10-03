import path from "node:path";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const PLACEMENT_SIDES = new Set(["front", "back", "left", "right"]);

export function validateConfig(config, filename) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("tenant config must be a JSON object");
  }
  if (typeof config.slug !== "string" || !SLUG_PATTERN.test(config.slug)) {
    throw new Error(`invalid tenant slug: ${config.slug}`);
  }
  if (filename && path.basename(filename) !== `${config.slug}.json`) {
    throw new Error(`tenant filename ${path.basename(filename)} must match slug ${config.slug}`);
  }
  if (!["live", "draft", "closed"].includes(config.status)) {
    throw new Error(`tenant ${config.slug} status must be live, draft, or closed`);
  }
  if (!config.payments || typeof config.payments !== "object" || Array.isArray(config.payments)) {
    throw new Error(`tenant ${config.slug} payments must be an object`);
  }
  if (config.payments.mode === "platform") {
    if ("feePercent" in config.payments || "country" in config.payments) {
      throw new Error(`tenant ${config.slug} platform payments must only specify mode`);
    }
  } else if (config.payments.mode === "connect") {
    if (typeof config.payments.feePercent !== "number" ||
        !Number.isFinite(config.payments.feePercent) ||
        config.payments.feePercent <= 0 ||
        config.payments.feePercent > 50) {
      throw new Error(`tenant ${config.slug} payments.feePercent must be greater than 0 and no more than 50`);
    }
    if (config.payments.country === undefined) config.payments.country = "US";
    if (typeof config.payments.country !== "string" || !/^[A-Z]{2}$/.test(config.payments.country)) {
      throw new Error(`tenant ${config.slug} payments.country must be two uppercase letters`);
    }
  } else {
    throw new Error(`tenant ${config.slug} payments.mode must be platform or connect`);
  }
  if (typeof config.copy?.paymentsPending !== "string" || !config.copy.paymentsPending.trim()) {
    throw new Error(`tenant ${config.slug} copy.paymentsPending must be a non-empty string`);
  }
  if (!Array.isArray(config.embedOrigins) || config.embedOrigins.some((origin) => typeof origin !== "string")) {
    throw new Error(`tenant ${config.slug} embedOrigins must be an array of strings`);
  }
  if (!Array.isArray(config.garments) || config.garments.length === 0) {
    throw new Error(`tenant ${config.slug} needs at least one garment`);
  }

  const ids = new Set();
  for (const garment of config.garments) {
    if (!Array.isArray(garment.placements)) {
      throw new Error(`garment ${garment.id} needs placements`);
    }
    for (const placement of garment.placements) {
      if (typeof placement.id !== "string" || !placement.id) {
        throw new Error(`tenant ${config.slug} has a placement without an id`);
      }
      if (placement.id.length > 8) {
        throw new Error(`placement id ${placement.id} must be 8 characters or fewer`);
      }
      if (ids.has(placement.id)) {
        throw new Error(`duplicate placement id: ${placement.id}`);
      }
      if (!placement.label || !PLACEMENT_SIDES.has(placement.side)) {
        throw new Error(`placement ${placement.id} needs a label and valid side`);
      }
      ids.add(placement.id);
    }
  }

  const accent = config.brand?.accent;
  if (typeof accent !== "string" || !/^#[0-9a-f]{6}$/i.test(accent)) {
    throw new Error(`tenant ${config.slug} brand.accent must be a six-digit hex color`);
  }
  if (!config.garments[0].placements[0]) {
    throw new Error(`garment ${config.garments[0].id} needs at least one placement`);
  }
  return config;
}
