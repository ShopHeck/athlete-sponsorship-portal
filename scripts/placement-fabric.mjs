// Records, then checks, the garment colour under every placement, so a regenerated model can be verified (and its
// placements re-fitted) against the layout that was approved on the previous one. Offline; no API calls.
//   node scripts/placement-fabric.mjs record <slug>   → scripts/fixtures/placement-fabric/<slug>.json
//   node scripts/placement-fabric.mjs check <slug>    → per-placement match against the recorded colours
// Each placement is sampled on a 9 × 7 grid exactly as the portal projects it (rest stance, square torso).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import sharp from "sharp";
import * as THREE from "three";
import { loadPosed } from "./refit-placements.mjs";

const RAYS = {
  front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
  back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)],
  left: (x, y) => [new THREE.Vector3(3, y, x), new THREE.Vector3(-1, 0, 0)],
  right: (x, y) => [new THREE.Vector3(-3, y, -x), new THREE.Vector3(1, 0, 0)]
};
export const MATCH_DISTANCE = 60; // RGB distance that still counts as the same fabric under different shading
export const MATCH_SHARE = 0.9;   // share of a placement's samples that must match a colour it showed before
const PALETTE_STEP = 25;          // recorded colours closer than this collapse into one palette entry

const fixturePath = (slug) => new URL(`./fixtures/placement-fabric/${slug}.json`, import.meta.url);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function texturePixels(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule()
  });
  const image = (await io.read(file)).getRoot().listMaterials()[0].getBaseColorTexture().getImage();
  return sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

// Colours under each placement's sample grid, keyed by placement ID (null where a ray misses the body).
export async function samplePlacements(config, file) {
  const { data, info } = await texturePixels(file);
  const { meshes, motion } = await loadPosed(file, config, config.motion.rest);
  const out = {};
  motion.withProjectionPose(() => {
    for (const spot of config.garments.flatMap((garment) => garment.placements)) {
      const samples = [];
      for (let x = 0; x <= 8; x++) for (let y = 0; y <= 6; y++) {
        const hit = new THREE.Raycaster(...RAYS[spot.side](spot.x + (x / 8 - 0.5) * spot.w, spot.y + (y / 6 - 0.5) * spot.h))
          .intersectObjects(meshes, false)[0];
        if (!hit?.uv) { samples.push(null); continue; }
        const px = Math.min(info.width - 1, Math.max(0, Math.round(hit.uv.x * (info.width - 1))));
        const py = Math.min(info.height - 1, Math.max(0, Math.round(hit.uv.y * (info.height - 1))));
        const o = (py * info.width + px) * 4;
        samples.push([data[o], data[o + 1], data[o + 2]]);
      }
      out[spot.id] = samples;
    }
  });
  return out;
}

export async function checkPlacements(config, file, fixture) {
  const sampled = await samplePlacements(config, file);
  return Object.entries(sampled).map(([id, samples]) => {
    const recorded = fixture.placements[id];
    if (!recorded) return { id, ok: false, reason: "no recorded fabric" };
    // A slot may legitimately span two materials (lapel and belt, waistband and trunks), so a sample passes when it
    // matches any colour the slot showed on the approved model. Skin where there was none fails, and so does
    // overhang beyond what the approved layout already had (sleeve slots wrap a little past a hanging arm).
    const hits = samples.filter(Boolean);
    const misses = hits.filter((rgb) => !recorded.palette.some((colour) => distance(rgb, colour) <= MATCH_DISTANCE));
    const overhang = samples.length - hits.length;
    const share = 1 - (misses.length + Math.max(0, overhang - recorded.overhang)) / samples.length;
    return { id, share, misses, overhang, ok: share >= MATCH_SHARE };
  });
}

async function main() {
  const [mode, slug] = process.argv.slice(2);
  if (!["record", "check"].includes(mode) || !slug) throw new Error("usage: placement-fabric.mjs record|check <slug>");
  const config = JSON.parse(await readFile(new URL(`../tenants/${slug}.json`, import.meta.url), "utf8"));
  const file = new URL(`../public/tenants/${slug}/${config.model}`, import.meta.url).pathname;
  if (mode === "record") {
    const sampled = await samplePlacements(config, file);
    const placements = Object.fromEntries(Object.entries(sampled).map(([id, samples]) => {
      const palette = [];
      for (const rgb of samples.filter(Boolean)) if (!palette.some((colour) => distance(rgb, colour) < PALETTE_STEP)) palette.push(rgb);
      return [id, { overhang: samples.filter((rgb) => !rgb).length, palette }];
    }));
    await mkdir(new URL("./fixtures/placement-fabric/", import.meta.url), { recursive: true });
    await writeFile(fixturePath(slug), `${JSON.stringify({ slug, model: config.model, placements }, null, 2)}\n`);
    console.log(`recorded ${Object.keys(placements).length} placements for ${slug}`);
    return;
  }
  const fixture = JSON.parse(await readFile(fixturePath(slug), "utf8"));
  const results = await checkPlacements(config, file, fixture);
  for (const r of results) {
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(8)} ${r.reason || `${Math.round(r.share * 100)}% match` +
      (r.ok ? "" : `; overhang ${r.overhang}; unmatched e.g. ${r.misses.slice(0, 3).map((rgb) => `rgb(${rgb})`).join(" ") || "none"}`)}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
