import * as THREE from "three";

// Meshy athletes arrive as one colour atlas with no material maps, so skin, cloth and gloves all render as the same
// flat matte. This upgrades such a material in place of a texture bake: skin is found per pixel from the albedo (warm,
// moderately saturated) and gets a soft specular sheen, cloth keeps a matte finish with a fabric sheen at grazing
// angles, and the albedo's own baked folds and weave drive a light bump so garments read as fabric, not paint.
// Kits that ship their own roughness/normal maps (scripts/polish-kit.mjs) keep them and are left alone.
export const SKIN_ROUGHNESS = 0.5;
export const CLOTH_ROUGHNESS = 0.88;

export function athleteMaterial(source, { anisotropy = 1 } = {}) {
  const map = source.map;
  if (map) { map.anisotropy = anisotropy; map.needsUpdate = true; }
  if (source.roughnessMap || source.normalMap || !map) {
    if (!source.roughnessMap) { source.metalness = 0; source.roughness = 0.9; }
    source.side = THREE.FrontSide;
    return source;
  }
  const material = new THREE.MeshPhysicalMaterial({
    name: source.name,
    map,
    color: source.color,
    metalness: 0,
    roughness: CLOTH_ROUGHNESS,
    // Grazing-angle fabric sheen; masked off skin in the shader below.
    sheen: 1,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0xffffff),
    bumpMap: map,
    bumpScale: 0.35,
    side: THREE.FrontSide
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.skinRoughness = { value: SKIN_ROUGHNESS };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float skinRoughness;
float skinMask = 0.0;`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
{
  // Skin test in display space: red over green over blue, moderately saturated, not near-black.
  vec3 c = pow(max(diffuseColor.rgb, vec3(1e-5)), vec3(1.0 / 2.2));
  float hi = max(c.r, max(c.g, c.b)), lo = min(c.r, min(c.g, c.b));
  float sat = (hi - lo) / max(hi, 1e-4);
  float warm = smoothstep(-0.01, 0.03, c.r - c.g) * smoothstep(-0.01, 0.03, c.g - c.b);
  skinMask = warm * smoothstep(0.1, 0.2, sat) * (1.0 - smoothstep(0.62, 0.75, sat)) * smoothstep(0.18, 0.32, hi);
  roughnessFactor = mix(roughnessFactor, skinRoughness, skinMask);
}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
normal = normalize(mix(normal, nonPerturbedNormal, skinMask)); // relief on cloth only: skin stays smooth`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
// Sheen takes the cloth's own colour, so black fabric stays black instead of greying out.
material.sheenColor *= (1.0 - skinMask) * diffuseColor.rgb;`);
  };
  material.customProgramCacheKey = () => "athlete-v1";
  source.dispose();
  return material;
}
