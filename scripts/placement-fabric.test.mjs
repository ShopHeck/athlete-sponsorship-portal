import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { checkPlacements } from "./placement-fabric.mjs";

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
