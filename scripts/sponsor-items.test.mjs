import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ITEM_PLACEMENTS, SPONSOR_ITEMS, SURFACE_ANCHORS, countsCovering, itemCatalog, itemGarments,
  offeredItemPlacementIds, validateItemCounts
} from "../netlify/lib/sponsor-items.mjs";
import { validateConfig } from "../netlify/lib/validate.mjs";

const tenantIds = fs.readdirSync("tenants").filter((file) => file.endsWith(".json"))
  .flatMap((file) => JSON.parse(fs.readFileSync(`tenants/${file}`, "utf8")).garments
    .flatMap((garment) => garment.placements.map((placement) => placement.id)));
const allCounts = Object.fromEntries(SPONSOR_ITEMS.map((item) => [item.id, item.slots.length]));

test("the catalog covers the requested placeholder items", () => {
  assert.deepEqual(SPONSOR_ITEMS.map((item) => item.id).sort(),
    ["banner", "gloves", "hat", "rashguard-long", "rashguard-short", "robe", "tee"]);
});

test("item placement IDs are short, unique and never collide with kit placements", () => {
  const ids = [...ITEM_PLACEMENTS.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(id.length <= 8, id);
    assert.ok(!tenantIds.includes(id), `${id} collides with a tenant placement`);
  }
});

test("prop slots name an anchor their surface builds and apparel slots only use arm anchors", () => {
  for (const item of SPONSOR_ITEMS) {
    for (const slot of item.slots) {
      assert.ok(["front", "back", "left", "right"].includes(slot.side), `${item.id} ${slot.name}`);
      assert.ok(slot.w > 0 && slot.h > 0, `${item.id} ${slot.name}`);
      if (item.surface === "body" && slot.anchor === undefined) continue;
      assert.ok(SURFACE_ANCHORS[item.surface].includes(slot.anchor), `${item.id} ${slot.name}`);
    }
  }
});

test("item counts are validated against the catalog", () => {
  assert.equal(validateItemCounts(undefined), null);
  assert.equal(validateItemCounts({ tee: 0, hat: 4 }), null);
  assert.match(validateItemCounts([]), /object/);
  assert.match(validateItemCounts({ cape: 1 }), /Unknown/);
  assert.match(validateItemCounts({ tee: 9 }), /0 to 8/);
  assert.match(validateItemCounts({ hat: 1.5 }), /whole number/);
  assert.match(validateItemCounts({ gloves: -1 }), /whole number/);
});

test("a count offers a stable prefix of the item's slots", () => {
  assert.deepEqual(offeredItemPlacementIds({ tee: 2, hat: 1 }), ["TEE-01", "TEE-02", "HAT-01"]);
  assert.deepEqual(offeredItemPlacementIds({ tee: 3 }).slice(0, 2), offeredItemPlacementIds({ tee: 2 }));
  assert.deepEqual(offeredItemPlacementIds(undefined), []);
});

test("counts can be raised to keep placements that have activity", () => {
  assert.deepEqual(countsCovering({ tee: 1 }, ["TEE-03", "HAT-02", "SF-L1"]), { tee: 3, hat: 2 });
  assert.deepEqual(countsCovering({ tee: 4 }, ["TEE-02"]), { tee: 4 });
});

test("item garments carry renamed labels and pass tenant validation", () => {
  const garments = itemGarments({ tee: 2, banner: 1 }, { "TEE-02": "Back sponsor" });
  assert.deepEqual(garments.map((garment) => garment.id), ["item-tee", "item-banner"]);
  assert.equal(garments[0].placements[1].label, "T-shirt · Back sponsor");
  assert.equal(garments[1].placements[0].anchor, "banner");

  const base = JSON.parse(fs.readFileSync("tenants/jordan-reyes.json", "utf8"));
  assert.doesNotThrow(() => validateConfig({ ...base, garments: [...base.garments, ...itemGarments(allCounts)] }));
  assert.doesNotThrow(() => validateConfig({ ...base, garments: itemGarments({ hat: 1 }) }));
});

test("the validator rejects malformed item garments", () => {
  const base = JSON.parse(fs.readFileSync("tenants/jordan-reyes.json", "utf8"));
  const [hat] = itemGarments({ hat: 1 });
  const withGarment = (garment) => ({ ...base, garments: [...base.garments, garment] });
  assert.throws(() => validateConfig(withGarment({ ...hat, item: "cape" })), /item must be one of/);
  assert.throws(() => validateConfig(withGarment({ ...hat, placements: [{ ...hat.placements[0], anchor: "banner" }] })),
    /anchor must be one of head/);
  const [tee] = itemGarments({ tee: 1 });
  assert.throws(() => validateConfig(withGarment({ ...tee, placements: [{ ...tee.placements[0], anchor: "head" }] })),
    /anchor must be one of leftUpperArm/);
  assert.throws(() => validateConfig({ ...base, garments: [{ ...base.garments[0],
    placements: [{ ...base.garments[0].placements[0], anchor: "leftHand" }] }] }), /only allowed on a sponsorship item/);
});

test("the dashboard catalog lists every slot", () => {
  const catalog = itemCatalog();
  assert.equal(catalog.find((item) => item.id === "gloves").max, 4);
  assert.deepEqual(catalog.find((item) => item.id === "hat").placements[0], { id: "HAT-01", name: "Front panel", side: "front" });
});
