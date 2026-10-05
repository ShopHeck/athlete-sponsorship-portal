import platform from "./platform.generated.json";
import { resolveTenantAssets } from "./render.mjs";
import template from "./starter-template.json";
import { deriveBrand } from "./brand.mjs";

const KIT_SOURCES = [
  { id: "boxing-trunks", name: "Boxing trunks", sport: "Men's Boxing", source: "demo-boxing-men" },
  { id: "boxing-trunks-top", name: "Boxing trunks + crop top", sport: "Women's Boxing", source: "demo-boxing-women" },
  { id: "mma-shorts-top", name: "MMA shorts + sports top", sport: "Women's MMA", source: "demo-mma-women" },
  { id: "bkfc-shorts-shirt", name: "Fight shorts + walkout T-shirt", sport: "Bare knuckle", source: "michael-heckert" },
  { id: "gi", name: "Gi jacket + pants", sport: "Men's Jiu-Jitsu · Gi", source: "demo-bjj-gi-men" },
  { id: "nogi", name: "Rash guard + shorts", sport: "Men's Jiu-Jitsu · No-Gi", source: "demo-nogi-men" }
];

const clone = (value) => structuredClone(value);
const sourceTenant = (source) => {
  const config = platform.tenants?.[source];
  if (!config) throw new Error(`starter kit source tenant is missing: ${source}`);
  return resolveTenantAssets(config);
};

function kitFromSource(definition) {
  const source = sourceTenant(definition.source);
  const garments = clone(source.garments);
  const placements = garments.flatMap((garment) => garment.placements.map((placement) => ({
    id: placement.id,
    label: placement.label,
    garmentId: garment.id,
    garmentName: garment.label || garment.tab || garment.id
  })));
  return {
    id: definition.id,
    name: definition.name,
    sport: definition.sport,
    source: definition.source,
    garments,
    ring: clone(source.ring),
    model: source.model,
    modelFacing: source.modelFacing,
    pricing: {
      minBid: source.pricing.minBid,
      increment: source.pricing.increment,
      lockPrice: source.pricing.lockPrice
    },
    placements
  };
}

const KIT_RECORDS = KIT_SOURCES.map(kitFromSource);

export const STARTER_KITS = KIT_RECORDS.map(({ garments, ring, model, modelFacing, pricing, source, ...kit }) => kit);

export function getStarterKit(kitId) {
  const kit = KIT_RECORDS.find((entry) => entry.id === kitId);
  return kit ? clone(kit) : null;
}

const jordan = platform.tenants?.["jordan-reyes"];
if (!jordan) throw new Error("jordan-reyes is required for starter templates");

const replaceSourceName = (value) => {
  if (typeof value !== "string") return value;
  return value
    .replace(/jordan-reyes/gi, "{{firstName}}-portal")
    .replace(/JORDAN REYES/g, "{{FULLNAME}}")
    .replace(/Jordan Reyes/g, "{{fullName}}")
    .replace(/Jordan/g, "{{firstName}}")
    .replace(/Reyes/g, "{{fullName}}");
};

function mapStrings(value, transform = replaceSourceName) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  }
  return value;
}

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return clone(override ?? base);
  const result = clone(base || {});
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key], value)
      : clone(value);
  }
  return result;
}

const sourceTemplate = {
  seo: mapStrings(jordan.seo),
  hero: mapStrings(jordan.hero),
  benefits: mapStrings(jordan.benefits),
  packageName: mapStrings(jordan.packageName),
  athlete: { footerLine: jordan.athlete.footerLine },
  event: {
    portalSubtitle: mapStrings(jordan.event.portalSubtitle),
    lockupKicker: jordan.event.lockupKicker
  },
  copy: mapStrings(jordan.copy)
};
const starterTemplate = merge(sourceTemplate, template);

const money = (amount) => `$${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const eventDate = (date) => new Date(`${date}T00:00:00.000Z`);
const dateShort = (date) => eventDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateLockup = (date) => eventDate(date)
  .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  .toUpperCase();

function valuesFor(settings, kit) {
  const fullName = String(settings.fullName || "").trim();
  const firstName = fullName.split(/\s+/)[0] || fullName;
  const initials = fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
  return {
    fullName,
    FULLNAME: fullName.toUpperCase(),
    firstName,
    eventName: settings.eventName,
    eventDateShort: dateShort(settings.eventDate),
    minBid: money(settings.minBid ?? kit.pricing.minBid),
    lockPrice: money(settings.lockPrice ?? kit.pricing.lockPrice),
    initials
  };
}

function fill(value, values) {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, key) => values[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  }
  return value;
}

export function starterDefaults(settings, kitId) {
  const kit = getStarterKit(kitId);
  if (!kit) return null;
  const values = valuesFor(settings, kit);
  const source = fill(starterTemplate, values);
  return {
    packageName: source.packageName,
    benefits: source.benefits,
    intro: source.hero.intro
  };
}

export function materializeConfig(settings, kitId) {
  const kit = getStarterKit(kitId);
  if (!kit) throw new Error(`unknown starter kit: ${kitId}`);
  const values = valuesFor(settings, kit);
  const platformUrl = (process.env.PLATFORM_URL || "http://localhost:8890").replace(/\/+$/, "");
  const source = fill(starterTemplate, values);
  const copy = fill(source.copy, values);
  const config = {
    slug: settings.slug,
    status: settings.status || "draft",
    embedOrigins: [],
    homeUrl: `${platformUrl}/`,
    athlete: {
      firstName: values.firstName,
      displayName: values.FULLNAME,
      fullDisplay: values.FULLNAME,
      brandMark: values.initials,
      footerLine: fill(template.athlete.footerLine, values)
    },
    event: {
      name: settings.eventName,
      date: settings.eventDate,
      portalSubtitle: fill(template.event.portalSubtitle, values),
      lockupKicker: template.event.lockupKicker,
      lockupDate: dateLockup(settings.eventDate),
      timeZone: settings.timeZone
    },
    seo: source.seo,
    hero: {
      ...source.hero,
      intro: settings.intro || source.hero.intro
    },
    poster: null,
    brand: deriveBrand(settings.accent),
    model: kit.model,
    ...(kit.modelFacing ? { modelFacing: kit.modelFacing } : {}),
    ring: kit.ring,
    pricing: {
      minBid: settings.minBid,
      increment: settings.increment,
      lockPrice: settings.lockPrice,
      deadline: settings.deadline,
      currency: "usd"
    },
    payments: { mode: "connect", feePercent: settings.feePercent, country: "US" },
    contact: {
      notifyEmail: settings.email,
      notifyFrom: `${values.fullName} Sponsorships <sponsors@michaelheckert.com>`,
      contactLinkText: `Questions? Email ${values.firstName}.`
    },
    packageName: settings.packageName,
    benefits: settings.benefits,
    copy,
    garments: kit.garments
      .map((garment) => ({
        ...garment,
        placements: garment.placements.filter((placement) => settings.offeredPlacementIds.includes(placement.id))
      }))
      .filter((garment) => garment.placements.length > 0),
    sold: {}
  };
  return config;
}
