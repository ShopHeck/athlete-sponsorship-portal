const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
}[char]));
const escapeText = (value) => String(value).replace(/[&<>]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;"
}[char]));

const resolveAsset = (slug, value) => {
  if (typeof value !== "string" || value.startsWith("/") || value.startsWith("http")) return value;
  return `/tenants/${slug}/${value.replace(/^(?:\.\/)+/, "")}`;
};

export function resolveTenantAssets(config) {
  const resolved = structuredClone(config);
  resolved.model = resolveAsset(resolved.slug, resolved.model);
  if (resolved.poster) {
    for (const key of ["card", "stage900", "stage1500", "ogImage"]) {
      resolved.poster[key] = resolveAsset(resolved.slug, resolved.poster[key]);
    }
  }
  for (const entry of Object.values(resolved.sold || {})) {
    if (entry.logo) entry.logo = resolveAsset(resolved.slug, entry.logo);
  }
  return resolved;
}

const formatTemplate = (text, values) => String(text).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => {
  if (!(key in values)) throw new Error(`missing template value {${key}}`);
  return values[key];
});

export function renderPortal(config, { template, version, portalUrl }) {
  const tenant = resolveTenantAssets(config);
  const currency = (amount) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: tenant.pricing.currency.toUpperCase(),
    maximumFractionDigits: 0
  }).format(amount);
  const imageUrl = (asset) => asset.startsWith("http") ? asset : new URL(asset, portalUrl).href;
  const copyValues = {
    minBid: currency(tenant.pricing.minBid),
    increment: currency(tenant.pricing.increment)
  };
  const firstPlacement = tenant.garments[0].placements[0];
  const initialBidNote = formatTemplate(tenant.copy.bidNoteInitial, copyValues);
  const garmentTabs = tenant.garments.map((garment, index) =>
    `<button class="garment-tab${index === 0 ? " is-active" : ""}" data-garment="${escapeHtml(garment.id)}" role="tab" aria-selected="${index === 0}">${escapeHtml(garment.tab)}</button>`
  ).join("\n          ");
  const benefitItems = tenant.benefits.map((benefit) => `<li>${escapeHtml(benefit)}</li>`).join("\n                ");
  const posterPreload = tenant.poster
    ? `<link rel="preload" as="image" href="${escapeHtml(tenant.poster.stage900)}" imagesrcset="${escapeHtml(tenant.poster.stage900)} 900w, ${escapeHtml(tenant.poster.stage1500)} 1500w" imagesizes="(max-width: 820px) 100vw, 50vw">`
    : "";
  const posterMeta = tenant.poster
    ? `<meta property="og:image" content="${escapeHtml(imageUrl(tenant.poster.ogImage))}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(tenant.seo.ogImageAlt)}">`
    : "";
  const posterTwitterImage = tenant.poster
    ? `<meta name="twitter:image" content="${escapeHtml(imageUrl(tenant.poster.ogImage))}">`
    : "";
  const posterCard = tenant.poster
    ? `<button type="button" class="poster-card" id="posterButton" aria-haspopup="dialog" aria-controls="posterDialog">
          <img src="${escapeHtml(tenant.poster.card)}" alt="${escapeHtml(tenant.poster.alt)}" width="819" height="1024" loading="lazy" decoding="async">
          <span class="poster-card-text"><span class="poster-card-kicker">${escapeHtml(tenant.poster.kicker)}</span><strong>${escapeHtml(tenant.poster.title)}</strong><small>${escapeHtml(tenant.poster.subtitle)}</small></span>
        </button>`
    : "";
  const stageBackdrop = tenant.poster
    ? `<div class="stage-backdrop" aria-hidden="true">
          <img src="${escapeHtml(tenant.poster.stage900)}" srcset="${escapeHtml(tenant.poster.stage900)} 900w, ${escapeHtml(tenant.poster.stage1500)} 1500w" sizes="(max-width: 820px) 100vw, 50vw" alt="" decoding="async" fetchpriority="high">
        </div>`
    : "";
  const posterDialog = tenant.poster
    ? `<dialog class="poster-dialog" id="posterDialog" aria-label="${escapeHtml(tenant.copy.posterDialogLabel)}">
    <button type="button" class="poster-dialog-close" id="posterClose" aria-label="${escapeHtml(tenant.copy.dialogCloseAriaLabel)}">×</button>
    <img src="${escapeHtml(tenant.poster.card)}" alt="${escapeHtml(tenant.poster.dialogAlt)}" width="819" height="1024">
  </dialog>`
    : "";
  const configJson = JSON.stringify(tenant).replace(/</g, "\\u003c");
  const studioAssets = ["athlete", "operator"].includes(tenant.studio?.mode)
    ? `<link rel="stylesheet" href="/studio.css?v=${escapeHtml(version)}"><script type="module" src="/studio.js?v=${escapeHtml(version)}"></script>`
    : "";
  const context = {
    ...tenant,
    firstPlacement,
    version,
    portalUrl,
    posterPreload,
    posterMeta,
    posterTwitterImage,
    posterCard,
    stageBackdrop,
    posterDialog,
    studioAssets,
    garmentTabs,
    benefitItems,
    initialBidNote,
    initialMinBid: tenant.pricing.minBid,
    initialIncrement: tenant.pricing.increment,
    initialOrientationLabel: tenant.copy.frontView.toUpperCase(),
    initialLockPrice: currency(tenant.pricing.lockPrice),
    initialLockLabel: formatTemplate(tenant.copy.lockLabel, { price: currency(tenant.pricing.lockPrice) }),
    initialPriceSymbol: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: tenant.pricing.currency.toUpperCase(),
      maximumFractionDigits: 0
    }).formatToParts(0).find((part) => part.type === "currency")?.value || "$",
    embedCode: escapeText(`<iframe src="${portalUrl}" title="${tenant.copy.embedTitle}" loading="lazy" allow="fullscreen" style="width:100%;height:900px;border:0"></iframe>`),
    configScript: `<script type="application/json" id="portal-config">${configJson}</script>`
  };
  const lookup = (path) => path.split(".").reduce((value, key) => value?.[key], context);
  const renderRaw = (_, path) => {
    const value = lookup(path);
    if (value === undefined || value === null) throw new Error(`missing raw template value: ${path}`);
    return String(value);
  };
  const renderEscaped = (_, path) => {
    const value = lookup(path);
    if (value === undefined || value === null) throw new Error(`missing template value: ${path}`);
    return escapeHtml(value);
  };

  const html = template
    .replace(/\{\{\{([A-Za-z][A-Za-z0-9.]*)\}\}\}/g, renderRaw)
    .replace(/\{\{([A-Za-z][A-Za-z0-9.]*)\}\}/g, renderEscaped);
  const accent = tenant.brand.accent.match(/^#([0-9a-f]{6})$/i);
  const accentRgb = [0, 2, 4].map((offset) => Number.parseInt(accent[1].slice(offset, offset + 2), 16)).join(",");
  const stylesheet = `<link rel="stylesheet" href="/styles.css?v=${escapeHtml(version)}">`;
  const htmlWithBrand = html.replace(
    stylesheet,
    `${stylesheet}\n  <style>:root{--orange:${tenant.brand.accent};--orange-dark:${tenant.brand.accentDark};--brand-wash:${tenant.brand.wash};--orange-hover:${tenant.brand.accentHover};--orange-pay-hover:${tenant.brand.accentPayHover};--orange-stroke:${tenant.brand.accentStroke};--orange-panel:${tenant.brand.accentPanel};--orange-gradient:${tenant.brand.accentGradient};--accent-rgb:${accentRgb}}</style>`
  );
  if (/\{\{\{?[A-Za-z]/.test(htmlWithBrand)) throw new Error(`unresolved template placeholder for ${tenant.slug}`);
  return htmlWithBrand;
}
