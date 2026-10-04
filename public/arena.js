import * as THREE from "three";

/* ---------------------------------------------------------------------------
   Circular "squared circle" ropes around the athlete: a circular rope line
   on padded posts with turnbuckles, sitting on the dark stage. The stage
   backdrop stays the portal's own poster treatment. Units are metres; the
   floor is y = 0 where the athlete stands.
--------------------------------------------------------------------------- */

export const RING_RADIUS = 3.55;
export const ROPE_RADIUS = RING_RADIUS - 0.24;
const POST_COUNT = 8;
const ROPE_HEIGHTS = [0.48, 0.8, 1.12, 1.44];

// Padded turnbuckle cover with the configured mark running vertically, repeated four
// times around the cylinder so it reads from every camera angle.
function padTexture(base, ink, text) {
  if (text == null) return null;
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext("2d");
  ctx.fillStyle = base; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = ink;
  ctx.font = "900 215px 'Barlow Condensed', Impact, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(c.width * (i + 0.5) / 4, c.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.letterSpacing = "18px";
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function octagonVertices(apothem) {
  const radius = apothem / Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, index) => {
    const angle = Math.PI / 8 + index * Math.PI / 4;
    return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  });
}

function fenceTexture(maxAnisotropy) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.lineWidth = 2.5;
  context.beginPath();
  for (let offset = -128; offset <= 256; offset += 128) {
    context.moveTo(offset, 0);
    context.lineTo(offset + 128, 128);
    context.moveTo(offset, 128);
    context.lineTo(offset + 128, 0);
  }
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

function canvasTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const context = canvas.getContext("2d");
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4;
      const dx = (x / (canvas.width - 1)) * 2 - 1;
      const dz = (y / (canvas.height - 1)) * 2 - 1;
      const vignette = 1 - 0.14 * Math.min(1, dx * dx + dz * dz);
      const seed = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      const grain = (seed - Math.floor(seed)) * 5 - 2.5;
      image.data[index] = 21 * vignette + grain;
      image.data[index + 1] = 23 * vignette + grain;
      image.data[index + 2] = 25 * vignette + grain;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function geometryFromPositions(positions, uvs = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

function buildOctagonArena(scene, ringConfig, { accentColor = "#14a3a8", maxAnisotropy = 1 } = {}) {
  const group = new THREE.Group();
  group.name = "ring";
  const vertices = octagonVertices(RING_RADIUS);
  const segmentLength = vertices[0].distanceTo(vertices[1]);
  const postHeight = 1.85;
  const fenceBottom = 0.17;
  const fenceTop = 1.7;
  const fenceHeight = fenceTop - fenceBottom;
  const cellSize = 0.055;
  const accent = new THREE.Color(accentColor);

  const postMap = padTexture(ringConfig.padColor, "#f4efe6", ringConfig.padText);
  const padMat = new THREE.MeshStandardMaterial({
    ...(postMap ? { map: postMap } : { color: ringConfig.padColor }),
    roughness: 0.9
  });
  const apronMat = new THREE.MeshStandardMaterial({ color: ringConfig.padColor, roughness: 0.9 });
  const railMat = new THREE.MeshStandardMaterial({
    color: ringConfig.padColor,
    roughness: 0.82,
    metalness: 0.04
  });

  const postGeometry = new THREE.CylinderGeometry(0.14, 0.14, postHeight, 16);
  const posts = new THREE.InstancedMesh(postGeometry, padMat, vertices.length);
  const railAxis = new THREE.Vector3(0, 1, 0);
  const boxAxis = new THREE.Vector3(1, 0, 0);
  const dummy = new THREE.Object3D();
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index];
    dummy.position.set(start.x, postHeight / 2, start.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    posts.setMatrixAt(index, dummy.matrix);
  }

  const topRailGeometry = new THREE.CylinderGeometry(0.09, 0.09, segmentLength + 0.08, 12);
  const topRails = new THREE.InstancedMesh(topRailGeometry, padMat, vertices.length);
  const apronGeometry = new THREE.BoxGeometry(1, 1, 1);
  const aprons = new THREE.InstancedMesh(apronGeometry, apronMat, vertices.length);
  const bottomRailGeometry = new THREE.CylinderGeometry(0.035, 0.035, segmentLength + 0.08, 10);
  const bottomRails = new THREE.InstancedMesh(bottomRailGeometry, railMat, vertices.length);

  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const direction = end.clone().sub(start).normalize();
    const midpoint = start.clone().add(end).multiplyScalar(0.5);
    dummy.position.set(midpoint.x, 1.79, midpoint.z);
    dummy.quaternion.setFromUnitVectors(railAxis, direction);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    topRails.setMatrixAt(index, dummy.matrix);

    dummy.position.set(midpoint.x, 0.07, midpoint.z);
    dummy.quaternion.setFromUnitVectors(boxAxis, direction);
    dummy.scale.set(segmentLength + 0.02, 0.14, 0.05);
    dummy.updateMatrix();
    aprons.setMatrixAt(index, dummy.matrix);

    dummy.position.set(midpoint.x, 0.16, midpoint.z);
    dummy.quaternion.setFromUnitVectors(railAxis, direction);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bottomRails.setMatrixAt(index, dummy.matrix);
  }
  for (const mesh of [posts, topRails, aprons, bottomRails]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  const fencePositions = [];
  const fenceUvs = [];
  const fenceIndices = [];
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const base = fencePositions.length / 3;
    fencePositions.push(
      start.x, fenceBottom, start.z,
      end.x, fenceBottom, end.z,
      end.x, fenceTop, end.z,
      start.x, fenceTop, start.z
    );
    const repeatX = segmentLength / cellSize;
    const repeatY = fenceHeight / cellSize;
    fenceUvs.push(0, 0, repeatX, 0, repeatX, repeatY, 0, repeatY);
    fenceIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const fenceGeometry = geometryFromPositions(fencePositions, fenceUvs);
  fenceGeometry.setIndex(fenceIndices);
  fenceGeometry.computeVertexNormals();
  const fenceMap = fenceTexture(maxAnisotropy);
  const fence = new THREE.Mesh(fenceGeometry, new THREE.MeshStandardMaterial({
    color: 0x252a2c,
    map: fenceMap,
    metalness: 0.16,
    roughness: 0.78,
    alphaTest: 0.25,
    side: THREE.DoubleSide
  }));
  fence.castShadow = false;
  fence.receiveShadow = false;
  group.add(fence);

  const matVertices = [];
  const matUvs = [];
  const matCenter = new THREE.Vector3(0, -0.003, 0);
  const radius = RING_RADIUS / Math.cos(Math.PI / 8);
  const uvFor = (x, z) => [(x / radius + 1) / 2, (z / radius + 1) / 2];
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    matVertices.push(
      matCenter.x, matCenter.y, matCenter.z,
      next.x, matCenter.y, next.z,
      current.x, matCenter.y, current.z
    );
    matUvs.push(...uvFor(0, 0), ...uvFor(next.x, next.z), ...uvFor(current.x, current.z));
  }
  const mat = new THREE.Mesh(
    geometryFromPositions(matVertices, matUvs),
    new THREE.MeshStandardMaterial({ map: canvasTexture(), roughness: 0.94, metalness: 0.02, side: THREE.DoubleSide })
  );
  mat.receiveShadow = true;
  group.add(mat);

  const accentOuter = octagonVertices(RING_RADIUS - 0.35);
  const accentInner = octagonVertices(RING_RADIUS - 0.37);
  const accentPositions = [];
  for (let index = 0; index < vertices.length; index++) {
    const nextIndex = (index + 1) % vertices.length;
    const outerStart = accentOuter[index];
    const outerEnd = accentOuter[nextIndex];
    const innerStart = accentInner[index];
    const innerEnd = accentInner[nextIndex];
    const y = -0.0015;
    accentPositions.push(
      outerStart.x, y, outerStart.z,
      outerEnd.x, y, outerEnd.z,
      innerEnd.x, y, innerEnd.z,
      outerStart.x, y, outerStart.z,
      innerEnd.x, y, innerEnd.z,
      innerStart.x, y, innerStart.z
    );
  }
  const accentLine = new THREE.Mesh(
    geometryFromPositions(accentPositions),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.78, side: THREE.DoubleSide, toneMapped: false })
  );
  group.add(accentLine);

  scene.add(group);
  return { group, update() {} };
}

export function buildArena(scene, ringConfig, options = {}) {
  if (!ringConfig.enabled) return { update() {} };
  if (ringConfig.style === "octagon") return buildOctagonArena(scene, ringConfig, options);

  const ropeColors = ringConfig.ropeColors;
  const group = new THREE.Group();
  group.name = "ring";

  const postMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.55, metalness: 0.5 });
  const padMaterial = (color) => {
    const map = padTexture(color, "#f4efe6", ringConfig.padText);
    return new THREE.MeshStandardMaterial({ ...(map ? { map } : { color }), roughness: 0.92 });
  };
  const neutralPad = padMaterial(ringConfig.padColor);
  const redPad = padMaterial(ringConfig.cornerColors[0]);
  const bluePad = padMaterial(ringConfig.cornerColors[1]);
  const padFor = (i) => (i === 0 ? redPad : i === POST_COUNT / 2 ? bluePad : neutralPad);
  const capMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.9 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.35, metalness: 0.9 });
  const postGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.62, 16);
  const padGeo = new THREE.CylinderGeometry(0.1, 0.1, 1.2, 20);
  const capGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.2, 20);
  const baseGeo = new THREE.CylinderGeometry(0.16, 0.18, 0.04, 20);
  const hookGeo = new THREE.TorusGeometry(0.035, 0.008, 8, 16);
  const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.11, 10);
  const eyeGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.12, 8);

  const centre = new THREE.Vector3();
  for (let i = 0; i < POST_COUNT; i++) {
    const a = (i / POST_COUNT) * Math.PI * 2 + Math.PI / POST_COUNT;
    const x = Math.cos(a) * RING_RADIUS, z = Math.sin(a) * RING_RADIUS;
    const post = new THREE.Mesh(postGeo, postMat); post.position.set(x, 0.81, z); post.castShadow = true; group.add(post);
    const base = new THREE.Mesh(baseGeo, postMat); base.position.set(x, 0.02, z); group.add(base);
    const pad = new THREE.Mesh(padGeo, padFor(i)); pad.position.set(x, 0.95, z); pad.rotation.y = -a; group.add(pad);
    const cap = new THREE.Mesh(capGeo, capMat); cap.position.set(x, 1.6, z); group.add(cap);

    // turnbuckles: one per rope, on the inside face of the post, tensioning the rope
    ROPE_HEIGHTS.forEach((y) => {
      const tb = new THREE.Group();
      tb.position.set(x, y, z);
      tb.lookAt(centre.set(0, y, 0));
      const barrel = new THREE.Mesh(barrelGeo, steelMat); barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.16;
      const eye = new THREE.Mesh(eyeGeo, steelMat); eye.rotation.x = Math.PI / 2; eye.position.z = 0.06;
      const hook = new THREE.Mesh(hookGeo, steelMat); hook.position.z = 0.25;
      tb.add(barrel, eye, hook);
      group.add(tb);
    });
  }

  ROPE_HEIGHTS.forEach((y, i) => {
    const rope = new THREE.Mesh(
      new THREE.TorusGeometry(ROPE_RADIUS, 0.032, 10, 220),
      new THREE.MeshStandardMaterial({ color: ropeColors[i], roughness: 0.95 })
    );
    rope.rotation.x = Math.PI / 2; rope.position.y = y;
    rope.castShadow = true;
    group.add(rope);
  });

  // spacer straps between posts keep the ropes tied together
  const strapGeo = new THREE.BoxGeometry(0.05, ROPE_HEIGHTS[3] - ROPE_HEIGHTS[0] + 0.1, 0.02);
  for (let i = 0; i < POST_COUNT; i++) {
    const a = (i / POST_COUNT) * Math.PI * 2;
    const strap = new THREE.Mesh(strapGeo, capMat);
    strap.position.set(Math.cos(a) * ROPE_RADIUS, (ROPE_HEIGHTS[0] + ROPE_HEIGHTS[3]) / 2, Math.sin(a) * ROPE_RADIUS);
    strap.lookAt(0, strap.position.y, 0);
    group.add(strap);
  }

  scene.add(group);
  return { group, update() {} };
}
