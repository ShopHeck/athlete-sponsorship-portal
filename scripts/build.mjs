import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(root, process.env.PORTAL_CONFIG || "portal.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const template = readFileSync(path.join(root, "src/index.template.html"), "utf8");
const generatedConfig = path.join(root, "netlify/lib/portal-config.generated.json");
const outputHtml = path.join(root, "public/index.html");

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
}[char]));
const escapeText = (value) => String(value).replace(/[&<>]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;"
}[char]));
const resolvePath = (pathValue) => pathValue.split(".").reduce((value, key) => value?.[key], config);
const currency = (amount) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: config.pricing.currency.toUpperCase(),
  maximumFractionDigits: 0
}).format(amount);
const imageUrl = (asset) => new URL(asset, config.portalUrl).href;

if (!Array.isArray(config.garments) || config.garments.length === 0) throw new Error("portal config needs at least one garment");
const ids = new Set();
for (const garment of config.garments) {
  if (!Array.isArray(garment.placements)) throw new Error(`garment ${garment.id} needs placements`);
  for (const placement of garment.placements) {
    if (!placement.id || ids.has(placement.id)) throw new Error(`missing or duplicate placement id: ${placement.id}`);
    if (!placement.label || !["front", "back", "left", "right"].includes(placement.side)) {
      throw new Error(`placement ${placement.id} needs a label and valid side`);
    }
    ids.add(placement.id);
  }
}

const hex = config.brand.accent.match(/^#([0-9a-f]{6})$/i);
if (!hex) throw new Error("brand.accent must be a six-digit hex color");
const accentRgb = [0, 2, 4].map((offset) => Number.parseInt(hex[1].slice(offset, offset + 2), 16)).join(",");
const firstPlacement = config.garments[0].placements[0];
if (!firstPlacement) throw new Error(`garment ${config.garments[0].id} needs at least one placement`);

const formatTemplate = (text, values) => String(text).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`missing template value {${key}}`);
  return values[key];
});
const copyValues = {
  minBid: currency(config.pricing.minBid),
  increment: currency(config.pricing.increment)
};
const initialBidNote = formatTemplate(config.copy.bidNoteInitial, copyValues);
const garmentTabs = config.garments.map((garment, index) =>
  `<button class="garment-tab${index === 0 ? " is-active" : ""}" data-garment="${escapeHtml(garment.id)}" role="tab" aria-selected="${index === 0}">${escapeHtml(garment.tab)}</button>`
).join("\n          ");
const benefitItems = config.benefits.map((benefit) => `<li>${escapeHtml(benefit)}</li>`).join("\n                ");
const posterPreload = config.poster
  ? `<link rel="preload" as="image" href="${escapeHtml(config.poster.stage900)}" imagesrcset="${escapeHtml(config.poster.stage900)} 900w, ${escapeHtml(config.poster.stage1500)} 1500w" imagesizes="(max-width: 820px) 100vw, 50vw">`
  : "";
const posterMeta = config.poster
  ? `<meta property="og:image" content="${escapeHtml(imageUrl(config.poster.ogImage))}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(config.seo.ogImageAlt)}">`
  : "";
const posterTwitterImage = config.poster
  ? `<meta name="twitter:image" content="${escapeHtml(imageUrl(config.poster.ogImage))}">`
  : "";
const posterCard = config.poster
  ? `<button type="button" class="poster-card" id="posterButton" aria-haspopup="dialog" aria-controls="posterDialog">
          <img src="${escapeHtml(config.poster.card)}" alt="${escapeHtml(config.poster.alt)}" width="819" height="1024" loading="lazy" decoding="async">
          <span class="poster-card-text"><span class="poster-card-kicker">${escapeHtml(config.poster.kicker)}</span><strong>${escapeHtml(config.poster.title)}</strong><small>${escapeHtml(config.poster.subtitle)}</small></span>
        </button>`
  : "";
const stageBackdrop = config.poster
  ? `<div class="stage-backdrop" aria-hidden="true">
          <img src="${escapeHtml(config.poster.stage900)}" srcset="${escapeHtml(config.poster.stage900)} 900w, ${escapeHtml(config.poster.stage1500)} 1500w" sizes="(max-width: 820px) 100vw, 50vw" alt="" decoding="async" fetchpriority="high">
        </div>`
  : "";
const posterDialog = config.poster
  ? `<dialog class="poster-dialog" id="posterDialog" aria-label="${escapeHtml(config.copy.posterDialogLabel)}">
    <button type="button" class="poster-dialog-close" id="posterClose" aria-label="${escapeHtml(config.copy.dialogCloseAriaLabel)}">×</button>
    <img src="${escapeHtml(config.poster.card)}" alt="${escapeHtml(config.poster.dialogAlt)}" width="819" height="1024">
  </dialog>`
  : "";
const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
const configScript = `<script type="application/json" id="portal-config">${configJson}</script>`;
const context = {
  ...config,
  firstPlacement,
  posterPreload,
  posterMeta,
  posterTwitterImage,
  posterCard,
  stageBackdrop,
  posterDialog,
  garmentTabs,
  benefitItems,
  initialBidNote,
  initialMinBid: config.pricing.minBid,
  initialIncrement: config.pricing.increment,
  initialOrientationLabel: config.copy.frontView.toUpperCase(),
  initialLockPrice: currency(config.pricing.lockPrice),
  initialLockLabel: formatTemplate(config.copy.lockLabel, { price: currency(config.pricing.lockPrice) }),
  initialPriceSymbol: new Intl.NumberFormat("en-US", { style: "currency", currency: config.pricing.currency.toUpperCase(), maximumFractionDigits: 0 })
    .formatToParts(0).find((part) => part.type === "currency")?.value || "$",
  embedCode: escapeText(`<iframe src="${config.portalUrl}" title="${config.copy.embedTitle}" loading="lazy" allow="fullscreen" style="width:100%;height:900px;border:0"></iframe>`),
  accentRgb,
  configJson,
  configScript
};
const lookup = (pathValue) => pathValue.split(".").reduce((value, key) => value?.[key], context);
const renderRaw = (_, pathValue) => {
  const value = lookup(pathValue);
  if (value === undefined || value === null) throw new Error(`missing raw template value: ${pathValue}`);
  return String(value);
};
const renderEscaped = (_, pathValue) => {
  const value = lookup(pathValue);
  if (value === undefined || value === null) throw new Error(`missing template value: ${pathValue}`);
  return escapeHtml(value);
};

const html = template
  .replace(/\{\{\{([A-Za-z][A-Za-z0-9.]*)\}\}\}/g, renderRaw)
  .replace(/\{\{([A-Za-z][A-Za-z0-9.]*)\}\}/g, renderEscaped)
  .replace(
    '<link rel="stylesheet" href="styles.css">',
    `<link rel="stylesheet" href="styles.css">\n  <style>:root{--orange:${config.brand.accent};--orange-dark:${config.brand.accentDark};--brand-wash:${config.brand.wash};--orange-hover:${config.brand.accentHover};--orange-pay-hover:${config.brand.accentPayHover};--orange-stroke:${config.brand.accentStroke};--orange-panel:${config.brand.accentPanel};--orange-gradient:${config.brand.accentGradient};--accent-rgb:${accentRgb}}</style>`
  );
if (/\{\{[{]?[A-Za-z]/.test(html)) throw new Error("unresolved template placeholder in rendered HTML");
writeFileSync(outputHtml, html);
writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);

const stamp = spawnSync(process.execPath, [path.join(root, "scripts/stamp-assets.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
if (stamp.status !== 0) throw new Error("asset stamping failed");
console.log(`Built ${path.relative(root, outputHtml)} from ${path.relative(root, configPath)}`);
