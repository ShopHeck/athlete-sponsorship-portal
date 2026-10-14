// Placeholder sponsorship items a self-serve athlete can add to their 3D likeness on top of the starter kit.
// Each item lists its slots in the order they are offered: a count of N offers the first N slots, so a placement ID
// (e.g. TEE-03) always names the same spot however the count changes.
//
// Apparel items (`surface: "body"`) are projected onto the athlete like kit placements, in metres on the model's
// viewing side; sleeve spots instead sit on an arm bone (`leftUpperArm`, `leftForearm`, ...) so they land on the
// arm whatever the athlete's stance. Prop items are placeholder geometry the portal builds around the rig; their
// slots carry an `anchor` and x/y offsets from it: `head` (the hat), `leftHand`/`rightHand` (the gloves) or
// `banner` (a roll-up stand).

const body = (name, detail, side, x, y, w, h) => ({ name, detail, side, x, y, w, h });
const prop = (anchor, name, detail, side, x, y, w, h) => ({ anchor, name, detail, side, x, y, w, h });
const arm = (anchor, name, detail, side, w, h) => prop(anchor, name, detail, side, 0, 0, w, h);

const TORSO = {
  chest: body("Chest · Center", "Centered across the chest.", "front", 0, 1.4, 0.19, 0.08),
  upperBack: body("Upper back · Large", "Wide statement placement across the shoulder blades.", "back", 0, 1.42, 0.28, 0.12),
  chestLeft: body("Chest · Wearer's left", "Small mark over the heart.", "front", 0.1, 1.45, 0.09, 0.065),
  chestRight: body("Chest · Wearer's right", "Small mark on the right chest.", "front", -0.1, 1.45, 0.09, 0.065),
  leftSleeve: arm("leftUpperArm", "Left sleeve", "Upper arm on the wearer's left.", "left", 0.11, 0.07),
  rightSleeve: arm("rightUpperArm", "Right sleeve", "Upper arm on the wearer's right.", "right", 0.11, 0.07),
  lowerFront: body("Lower front · Center", "Centered above the waistband.", "front", 0, 1.22, 0.17, 0.07),
  lowerBack: body("Lower back · Center", "Centered on the lower back.", "back", 0, 1.25, 0.17, 0.07)
};

export const SPONSOR_ITEMS = [
  {
    id: "robe",
    code: "ROB",
    name: "Walkout robe",
    surface: "body",
    lateralLabel: "Sleeves",
    slots: [
      body("Back · Name panel", "The headline panel across the back of the robe.", "back", 0, 1.38, 0.32, 0.14),
      TORSO.chestLeft,
      TORSO.chestRight,
      body("Back · Lower panel", "Wide panel across the lower back of the robe.", "back", 0, 1.15, 0.26, 0.09),
      TORSO.leftSleeve,
      TORSO.rightSleeve,
      body("Front skirt · Wearer's left", "Front panel below the belt.", "front", 0.12, 1.0, 0.1, 0.08)
    ]
  },
  {
    id: "tee",
    code: "TEE",
    name: "T-shirt",
    surface: "body",
    lateralLabel: "Sleeves",
    slots: [
      TORSO.chest, TORSO.upperBack, TORSO.chestLeft, TORSO.chestRight,
      TORSO.leftSleeve, TORSO.rightSleeve, TORSO.lowerFront, TORSO.lowerBack
    ]
  },
  {
    id: "rashguard-short",
    code: "RGS",
    name: "Short-sleeve rash guard",
    surface: "body",
    lateralLabel: "Sleeves",
    slots: [TORSO.chest, TORSO.upperBack, TORSO.leftSleeve, TORSO.rightSleeve, TORSO.lowerBack, TORSO.lowerFront]
  },
  {
    id: "rashguard-long",
    code: "RGL",
    name: "Long-sleeve rash guard",
    surface: "body",
    lateralLabel: "Sleeves",
    slots: [
      TORSO.chest, TORSO.upperBack, TORSO.leftSleeve, TORSO.rightSleeve,
      arm("leftForearm", "Left forearm", "Forearm on the wearer's left.", "left", 0.1, 0.06),
      arm("rightForearm", "Right forearm", "Forearm on the wearer's right.", "right", 0.1, 0.06),
      TORSO.lowerBack, TORSO.lowerFront
    ]
  },
  {
    id: "hat",
    code: "HAT",
    name: "Hat",
    surface: "hat",
    lateralLabel: "Sides",
    slots: [
      prop("head", "Front panel", "Centered on the front of the crown.", "front", 0, 0.035, 0.085, 0.045),
      prop("head", "Back panel", "Above the strap on the back of the crown.", "back", 0, 0.03, 0.075, 0.035),
      prop("head", "Left side", "Side panel on the wearer's left.", "left", 0, 0.03, 0.065, 0.03),
      prop("head", "Right side", "Side panel on the wearer's right.", "right", 0, 0.03, 0.065, 0.03)
    ]
  },
  {
    id: "gloves",
    code: "GLV",
    name: "Gloves",
    surface: "gloves",
    lateralLabel: "Outsides",
    slots: [
      prop("leftHand", "Left glove · Front", "Knuckle face of the left glove.", "front", 0, 0, 0.075, 0.05),
      prop("rightHand", "Right glove · Front", "Knuckle face of the right glove.", "front", 0, 0, 0.075, 0.05),
      prop("leftHand", "Left glove · Outside", "Outer side of the left glove.", "left", 0, 0, 0.07, 0.045),
      prop("rightHand", "Right glove · Outside", "Outer side of the right glove.", "right", 0, 0, 0.07, 0.045)
    ]
  },
  {
    id: "banner",
    code: "BNR",
    name: "Banner",
    surface: "banner",
    lateralLabel: "Sides",
    slots: [
      prop("banner", "Header", "Full-width header across the top of the banner.", "front", 0, 0.6, 0.6, 0.2),
      prop("banner", "Center · Large", "The banner's main panel.", "front", 0, 0.24, 0.6, 0.34),
      prop("banner", "Middle · Left", "Left half of the middle row.", "front", -0.155, -0.1, 0.27, 0.15),
      prop("banner", "Middle · Right", "Right half of the middle row.", "front", 0.155, -0.1, 0.27, 0.15),
      prop("banner", "Lower · Left", "Left half of the lower row.", "front", -0.155, -0.34, 0.27, 0.15),
      prop("banner", "Lower · Right", "Right half of the lower row.", "front", 0.155, -0.34, 0.27, 0.15),
      prop("banner", "Footer", "Full-width strip along the bottom of the banner.", "front", 0, -0.6, 0.6, 0.13)
    ]
  }
];

export const ITEM_SURFACES = new Set(SPONSOR_ITEMS.map((item) => item.surface));
// The anchors each surface offers. Prop placements must name one; apparel placements may sit on an arm bone.
export const SURFACE_ANCHORS = {
  body: ["leftUpperArm", "rightUpperArm", "leftForearm", "rightForearm"],
  hat: ["head"],
  gloves: ["leftHand", "rightHand"],
  banner: ["banner"]
};

const ITEMS_BY_ID = new Map(SPONSOR_ITEMS.map((item) => [item.id, item]));
export const getSponsorItem = (id) => ITEMS_BY_ID.get(id) || null;
export const itemPlacementId = (item, index) => `${item.code}-${String(index + 1).padStart(2, "0")}`;

// Every placement ID the catalog can produce, mapped to its item and slot index.
export const ITEM_PLACEMENTS = new Map(SPONSOR_ITEMS.flatMap((item) =>
  item.slots.map((slot, index) => [itemPlacementId(item, index), { item, index, slot }])));

// Returns an error message for an invalid `{ itemId: count }` map, or null.
export function validateItemCounts(items) {
  if (items === undefined) return null;
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return "Sponsorship items must be an object of item counts.";
  }
  for (const [id, count] of Object.entries(items)) {
    const item = getSponsorItem(id);
    if (!item) return `Unknown sponsorship item: ${id}.`;
    if (!Number.isInteger(count) || count < 0 || count > item.slots.length) {
      return `${item.name} placements must be a whole number from 0 to ${item.slots.length}.`;
    }
  }
  return null;
}

// Placement IDs offered by a `{ itemId: count }` map, in catalog order.
export function offeredItemPlacementIds(items = {}) {
  return SPONSOR_ITEMS.flatMap((item) =>
    item.slots.slice(0, items?.[item.id] || 0).map((_, index) => itemPlacementId(item, index)));
}

// The smallest counts that still offer every given item placement ID (used to keep placements with activity).
export function countsCovering(items = {}, placementIds = []) {
  const next = { ...items };
  for (const id of placementIds) {
    const entry = ITEM_PLACEMENTS.get(id);
    if (entry) next[entry.item.id] = Math.max(next[entry.item.id] || 0, entry.index + 1);
  }
  return next;
}

// Tenant garments for the offered items, appended after the kit's garments. `placementNames` may rename slots.
export function itemGarments(items = {}, placementNames = {}, placementPricing = {}) {
  return SPONSOR_ITEMS
    .filter((item) => (items?.[item.id] || 0) > 0)
    .map((item) => ({
      id: `item-${item.id}`,
      tab: item.name,
      label: item.name,
      lateralLabel: item.lateralLabel,
      item: item.surface,
      placements: item.slots.slice(0, items[item.id]).map((slot, index) => {
        const id = itemPlacementId(item, index);
        const name = placementNames?.[id] || slot.name;
        const price = placementPricing?.[id];
        return {
          id,
          ...slot,
          name,
          label: `${item.name} · ${name}`,
          ...(Number.isInteger(price?.minBid) ? { minBid: price.minBid } : {}),
          ...(Number.isInteger(price?.lockPrice) ? { lockPrice: price.lockPrice } : {}),
          ...(price?.tier ? { tier: price.tier } : {})
        };
      })
    }));
}

// The catalog as the dashboard shows it.
export function itemCatalog() {
  return SPONSOR_ITEMS.map((item) => ({
    id: item.id,
    name: item.name,
    max: item.slots.length,
    placements: item.slots.map((slot, index) => ({ id: itemPlacementId(item, index), name: slot.name, side: slot.side }))
  }));
}
