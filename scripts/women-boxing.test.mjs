import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import sharp from "sharp";
import * as THREE from "three";
import { loadPosed } from "./refit-placements.mjs";

const config = JSON.parse(await readFile(new URL("../tenants/demo-boxing-women.json", import.meta.url)));
const file = new URL(`../public/tenants/demo-boxing-women/${config.model}`, import.meta.url).pathname;

test("Jada's chest slot sits at the centre of the sports bra with fabric all round it", async () => {
  // The slot once sat at 1.435 m, above the bra's neckline on bare skin. Decals follow the body's own triangles in
  // every move, so 1 cm of black bra fabric must remain beyond each edge.
  const MARGIN = 0.01;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule()
  });
  const texture = (await io.read(file)).getRoot().listMaterials()[0].getBaseColorTexture().getImage();
  const { data, info } = await sharp(texture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { meshes, motion } = await loadPosed(file, config, config.motion.rest);
  const isFabric = (x, y) => {
    const hit = new THREE.Raycaster(new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)).intersectObjects(meshes)[0];
    if (!hit?.uv) return false;
    const px = Math.round(hit.uv.x * (info.width - 1)), py = Math.round(hit.uv.y * (info.height - 1));
    const [r, g, b] = data.subarray((py * info.width + px) * 4, (py * info.width + px) * 4 + 3);
    return Math.max(r, g, b) < 100;
  };
  const chest = config.garments.flatMap((garment) => garment.placements).find(({ id }) => id === "CT-F1");
  motion.withProjectionPose(() => {
    let top = -Infinity, bottom = Infinity;
    for (let y = 1.15; y <= 1.39; y += 0.0025) if (isFabric(0, y)) { top = Math.max(top, y); bottom = Math.min(bottom, y); }
    assert.ok(Math.abs(chest.y - (top + bottom) / 2) <= 0.015,
      `CT-F1 centre ${chest.y} should be within 1.5 cm of the bra centre ${((top + bottom) / 2).toFixed(3)}`);
    assert.ok(Math.abs(chest.x) <= 0.01, "CT-F1 is centred left to right");
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 6; j++) {
      const x = chest.x + (i / 8 - 0.5) * (chest.w + 2 * MARGIN), y = chest.y + (j / 6 - 0.5) * (chest.h + 2 * MARGIN);
      assert.ok(isFabric(x, y), `CT-F1 needs bra fabric at x=${x.toFixed(3)}, y=${y.toFixed(3)}`);
    }
  });
});
