import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, prune, textureCompress } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const MAX_OPTIMIZED_BYTES = 20 * 1024 * 1024;
const require = createRequire(import.meta.url);

function dracoDirectoriesFrom(start) {
  const directories = [];
  let current = resolve(start);
  while (true) {
    directories.push(join(current, "node_modules", "draco3dgltf"));
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

const dracoDirectories = [...new Set([
  dirname(require.resolve("draco3dgltf")),
  ...dracoDirectoriesFrom(process.cwd()),
  ...dracoDirectoriesFrom(dirname(fileURLToPath(import.meta.url)))
])];

async function loadDracoWasm(filename) {
  for (const directory of dracoDirectories) {
    try {
      return await readFile(join(directory, filename));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Draco runtime assets are unavailable.");
}

let dracoModulesPromise;

async function dracoModules() {
  if (!dracoModulesPromise) {
    dracoModulesPromise = Promise.all([
      loadDracoWasm("draco_encoder.wasm"),
      loadDracoWasm("draco_decoder_gltf.wasm")
    ]).then(([encoderWasm, decoderWasm]) => Promise.all([
      draco3d.createEncoderModule({ wasmBinary: encoderWasm }),
      draco3d.createDecoderModule({ wasmBinary: decoderWasm })
    ]));
  }
  const [encoder, decoder] = await dracoModulesPromise;
  return { "draco3d.encoder": encoder, "draco3d.decoder": decoder };
}

function updateBounds(bounds, min, max) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], min[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], max[axis]);
  }
}

function accessorBounds(accessor) {
  const min = accessor.getMin([]);
  const max = accessor.getMax([]);
  if (min?.length >= 3 && max?.length >= 3) return { min, max };

  const array = accessor.getArray();
  if (!array) return null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < array.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], array[index + axis]);
      maximum[axis] = Math.max(maximum[axis], array[index + axis]);
    }
  }
  return Number.isFinite(minimum[0]) ? { min: minimum, max: maximum } : null;
}

function modelStats(document) {
  let triangles = 0;
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) continue;
      const positionBounds = accessorBounds(positions);
      if (positionBounds) updateBounds(bounds, positionBounds.min, positionBounds.max);
      const count = primitive.getIndices()?.getCount() || positions.getCount();
      const mode = primitive.getMode();
      triangles += mode === 5 || mode === 6 ? Math.max(0, count - 2) : Math.floor(count / 3);
    }
  }
  const extents = bounds.min.map((minimum, axis) =>
    Number.isFinite(minimum) && Number.isFinite(bounds.max[axis])
      ? bounds.max[axis] - minimum
      : 0);
  return {
    triangles,
    bounds: {
      x: Number(extents[0].toFixed(4)),
      y: Number(extents[1].toFixed(4)),
      z: Number(extents[2].toFixed(4))
    }
  };
}

async function largestTextureSize(document) {
  let largest = 0;
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const metadata = await sharp(Buffer.from(image)).metadata();
    largest = Math.max(largest, metadata.width || 0, metadata.height || 0);
  }
  return largest;
}

export async function optimizeGlb(inputBytes) {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies(await dracoModules());
  const document = await io.readBinary(new Uint8Array(inputBytes));
  const stats = modelStats(document);

  await document.transform(
    dedup(),
    prune(),
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [4096, 4096],
      quality: 85
    }),
    draco()
  );

  const textureSize = await largestTextureSize(document);
  const bytes = Buffer.from(await io.writeBinary(document));
  if (bytes.length > MAX_OPTIMIZED_BYTES) {
    throw new Error("Optimized model exceeds the 20 MB limit.");
  }

  const warnings = stats.bounds.y < Math.max(stats.bounds.x, stats.bounds.z)
    ? ["orientation"]
    : [];
  return { bytes, triangles: stats.triangles, textureSize, bounds: stats.bounds, warnings };
}
