// Moves a tenant's placement coordinates onto a new rest stance, offline and without API calls.
//   node scripts/refit-placements.mjs <slug> --from <old rest clip> [--write]
// Each placement is projected exactly as the portal does it (public/app.js makeSlot) on the old rest, the surface
// point under its centre and corners is followed onto the tenant's current motion.rest, and the new ray
// coordinates are printed (or written with --write). Drift is how far the new ray at each moved corner lands from the
// surface that corner covered before; "corner off body" means part of the footprint now overhangs (check it visually).
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createMotion } from "../public/motion.js";

const MODEL_HEIGHT = 1.86; // public/app.js
const TOLERANCE = 0.03;    // metres of corner drift worth a visual check
const SIDE_RAY = {
  front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
  back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)],
  left: (x, y) => [new THREE.Vector3(3, y, x), new THREE.Vector3(-1, 0, 0)],
  right: (x, y) => [new THREE.Vector3(-3, y, -x), new THREE.Vector3(1, 0, 0)]
};
const rayCoordinates = (side, p) => ({ front: [p.x, p.y], back: [p.x, p.y], left: [p.z, p.y], right: [-p.z, p.y] })[side];

export async function loadPosed(file, config, rest) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule()
  });
  const doc = await io.read(file);
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  for (const material of doc.getRoot().listMaterials()) {
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null).setEmissiveTexture(null);
  }
  const bytes = await io.writeBinary(doc);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const root = gltf.scene, meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const normalise = () => {
    const box = new THREE.Box3().setFromObject(root);
    root.scale.multiplyScalar(MODEL_HEIGHT / box.getSize(new THREE.Vector3()).y);
    root.updateMatrixWorld(true);
    box.setFromObject(root);
    root.position.x -= (box.min.x + box.max.x) / 2;
    root.position.y -= box.min.y;
    root.position.z -= (box.min.z + box.max.z) / 2;
    root.updateMatrixWorld(true);
  };
  normalise();
  const extent = (dir) => {
    let best = 0;
    for (const x of [-0.1, 0.1]) {
      const hit = new THREE.Raycaster(new THREE.Vector3(x, 0.05, dir * 3), new THREE.Vector3(0, 0, -dir)).intersectObjects(meshes, false)[0];
      if (hit) best = Math.max(best, Math.abs(hit.point.z));
    }
    return best;
  };
  const facesPositiveZ = config.modelFacing === "positive-z" || (config.modelFacing !== "negative-z" && extent(1) >= extent(-1));
  if (!facesPositiveZ) { root.rotateY(Math.PI); normalise(); }
  const motion = createMotion(root, gltf.animations, config.motion.clips, { rest, stance: rest === config.motion.rest ? config.motion.stance : undefined });
  return { root, meshes, motion };
}

// The surface under a ray as (mesh, triangle vertices, barycentric weights), so it can be followed into another pose.
function surfaceAt(meshes, origin, direction) {
  const hit = new THREE.Raycaster(origin, direction).intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const { a, b, c } = hit.face;
  const triangle = new THREE.Triangle(...[a, b, c].map((i) => hit.object.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(hit.object.matrixWorld)));
  const bary = triangle.getBarycoord(hit.point, new THREE.Vector3());
  return { mesh: hit.object.name || hit.object.uuid, index: hit.object.parent.children.indexOf(hit.object), vertices: [a, b, c], bary };
}

function follow(meshes, surface) {
  const mesh = meshes.find((m) => (m.name || m.uuid) === surface.mesh && m.parent.children.indexOf(m) === surface.index) ||
    meshes.find((m) => m.name === surface.mesh);
  const [pa, pb, pc] = surface.vertices.map((i) => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  return pa.multiplyScalar(surface.bary.x).addScaledVector(pb, surface.bary.y).addScaledVector(pc, surface.bary.z);
}

const corners = (spot) => [[0, 0], ...[-0.5, 0.5].flatMap((u) => [-0.5, 0.5].map((v) => [u, v]))]
  .map(([u, v]) => [spot.x + u * spot.w, spot.y + v * spot.h]);

export async function refit(config, file, fromRest) {
  const before = await loadPosed(file, config, fromRest);
  const after = await loadPosed(file, config, config.motion.rest);
  const results = [];
  for (const garment of config.garments) for (const spot of garment.placements) {
    const traced = before.motion.withProjectionPose(() => corners(spot).map(([x, y]) => surfaceAt(before.meshes, ...SIDE_RAY[spot.side](x, y))));
    if (!traced[0]) { results.push({ id: spot.id, error: "no surface under the old placement" }); continue; }
    const moved = after.motion.withProjectionPose(() => {
      const centre = follow(after.meshes, traced[0]);
      const [x, y] = rayCoordinates(spot.side, centre).map((v) => Math.round(v * 1000) / 1000);
      const shift = [x - spot.x, y - spot.y];
      // The new ray at each shifted corner must land on the surface the old corner sat on.
      let worst = 0;
      corners(spot).forEach(([cx, cy], k) => {
        if (!traced[k]) return;
        const hit = new THREE.Raycaster(...SIDE_RAY[spot.side](cx + shift[0], cy + shift[1])).intersectObjects(after.meshes, false)[0];
        const expected = follow(after.meshes, traced[k]);
        worst = Math.max(worst, hit ? hit.point.distanceTo(expected) : Infinity);
      });
      return { x, y, worst };
    });
    results.push({ id: spot.id, side: spot.side, from: [spot.x, spot.y], to: [moved.x, moved.y], drift: moved.worst,
      ok: moved.worst <= TOLERANCE, offBody: moved.worst === Infinity });
  }
  return results;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: "string" }, write: { type: "boolean" } } });
  const [slug] = positionals;
  if (!slug || !values.from) throw new Error("usage: refit-placements.mjs <slug> --from <old rest clip> [--write]");
  const path = new URL(`../tenants/${slug}.json`, import.meta.url);
  const text = await readFile(path, "utf8");
  const config = JSON.parse(text);
  const model = new URL(`../public/tenants/${slug}/${config.model}`, import.meta.url).pathname;
  const results = await refit(config, model, values.from);
  for (const r of results) {
    console.log(r.error ? `${r.id}: ${r.error}` :
      `${r.ok ? "ok   " : "CHECK"} ${r.id.padEnd(8)} ${r.side.padEnd(5)} ${r.from.join(",").padEnd(14)} → ${r.to.join(",").padEnd(14)} ` +
      (r.offBody ? "corner off body" : `drift ${(r.drift * 1000).toFixed(1)}mm`));
  }
  if (!values.write) return;
  let out = text;
  for (const r of results.filter((r) => r.to && (r.to[0] !== r.from[0] || r.to[1] !== r.from[1]))) {
    // Edit the two numbers in place so the file keeps its formatting.
    const pattern = new RegExp(`("id": "${r.id}"[^}]*?"x": )(-?[\\d.]+)([^}]*?"y": )(-?[\\d.]+)`);
    if (!pattern.test(out)) throw new Error(`could not locate ${r.id} in ${slug}.json`);
    out = out.replace(pattern, (_, a, _x, b) => `${a}${r.to[0]}${b}${r.to[1]}`);
  }
  await writeFile(path, out);
  const flagged = results.filter((r) => !r.ok).length;
  console.log(`wrote ${slug}.json${flagged ? `; check ${flagged} flagged placement(s) in the portal` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
