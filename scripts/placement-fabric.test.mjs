import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { OVERHANG_TOLERANCE, checkPlacements, scorePlacement } from "./placement-fabric.mjs";

// Each fixture records the garment colours under every placement on an approved model. A regenerated model (or a
// placement edit) must keep every slot on the same fabric: no skin, glove or background where there was none.
const fixtures = new URL("./fixtures/placement-fabric/", import.meta.url);
for (const file of (await readdir(fixtures)).filter((name) => name.endsWith(".json"))) {
  const fixture = JSON.parse(await readFile(new URL(file, fixtures), "utf8"));
  test(`${fixture.slug}: every placement stays on its recorded garment`, async () => {
    const config = JSON.parse(await readFile(new URL(`../tenants/${fixture.slug}.json`, import.meta.url), "utf8"));
    const results = await checkPlacements(config, new URL(`../public/tenants/${fixture.slug}/${config.model}`, import.meta.url).pathname, fixture);
    assert.deepEqual(results.map(({ id }) => id).sort(), Object.keys(fixture.placements).sort(), "fixture and tenant placements differ");
    for (const r of results) assert.ok(r.ok, `${r.id} matches only ${Math.round(r.share * 100)}% of its recorded fabric`);
  });
}

test("overhang is limited on its own and never spends the colour budget", () => {
  const white = [240, 240, 240], skin = [200, 150, 120];
  const recorded = { overhang: 18, palette: [white] };
  const grid = (empty, skinCount = 0) => [
    ...Array(empty).fill(null), ...Array(skinCount).fill(skin), ...Array(63 - empty - skinCount).fill(white)
  ];
  assert.equal(scorePlacement(grid(18), recorded).ok, true);
  assert.equal(scorePlacement(grid(18 + OVERHANG_TOLERANCE), recorded).ok, true);
  assert.equal(scorePlacement(grid(24), recorded).ok, false, "six extra empty samples must fail even if the rest match");
  assert.equal(scorePlacement(grid(18, 4), recorded).ok, true, "a few off-palette texels stay within the colour budget");
  assert.equal(scorePlacement(grid(18, 6), recorded).ok, false, "skin on 6 of 45 on-body samples fails");
  assert.equal(scorePlacement(grid(63), { overhang: 63, palette: [white] }).ok, false, "a slot with no body under it fails");
});
