import * as THREE from "three";

// Meshy athletes arrive either as one colour atlas with no material maps or with baked PBR maps whose skin and cloth
// still share a single standard BRDF. This upgrades both: skin is detected per pixel from the albedo (warm,
// moderately saturated) and receives subsurface dermis wrap scattering plus a dual-lobe oil/perspiration specular
// response, while cloth gets grazing-angle fabric sheen and high-frequency micro-weave relief without blocky WebP
// bump artifacts on skin.
export const SKIN_ROUGHNESS = 0.44;
export const CLOTH_ROUGHNESS = 0.88;

function applyAthleteShader(material, { hasPbrMaps = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.skinRoughness = { value: SKIN_ROUGHNESS };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
uniform float skinRoughness;
float skinMask = 0.0;
float microWeave(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
{
  // Skin test in display space: red over green over blue, moderately saturated, not near-black.
  vec3 c = pow(max(diffuseColor.rgb, vec3(1e-5)), vec3(1.0 / 2.2));
  float hi = max(c.r, max(c.g, c.b)), lo = min(c.r, min(c.g, c.b));
  float sat = (hi - lo) / max(hi, 1e-4);
  float warm = smoothstep(-0.01, 0.03, c.r - c.g) * smoothstep(-0.01, 0.03, c.g - c.b);
  skinMask = warm * smoothstep(0.1, 0.2, sat) * (1.0 - smoothstep(0.62, 0.75, sat)) * smoothstep(0.18, 0.32, hi);
  ${hasPbrMaps
    ? "roughnessFactor = mix(roughnessFactor, clamp(roughnessFactor * 0.8, 0.34, 0.5), skinMask);"
    : "roughnessFactor = mix(roughnessFactor, skinRoughness, skinMask);"}
}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${hasPbrMaps ? "" : "normal = normalize(mix(normal, nonPerturbedNormal, skinMask)); // relief on cloth only: skin stays smooth"}
#ifdef USE_MAP
{
  // Analytic screen-crisp micro-detail: fine pore relief on skin and textile weave on garments, free of WebP blockiness.
  vec2 detailUv = vMapUv * mix(220.0, 340.0, skinMask);
  float h0 = microWeave(detailUv);
  float hx = microWeave(detailUv + vec2(0.45, 0.0)) - h0;
  float hy = microWeave(detailUv + vec2(0.0, 0.45)) - h0;
  float detailScale = mix(0.022, 0.014, skinMask);
  normal = normalize(normal + vec3(hx, hy, 0.0) * detailScale);
}
#endif`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
#ifdef USE_SHEEN
// Sheen takes the cloth's own colour, so black fabric stays black instead of greying out.
material.sheenColor *= (1.0 - skinMask) * diffuseColor.rgb;
#endif`)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>
if (skinMask > 0.001) {
  // Subtle warm dermal scatter across shadow terminators + dual-lobe skin specular.
  float directLum = dot(reflectedLight.directDiffuse, vec3(0.299, 0.587, 0.114));
  float terminator = smoothstep(0.0, 0.35, directLum) * (1.0 - smoothstep(0.35, 0.9, directLum));
  vec3 sssTint = vec3(1.0, 0.62, 0.46) * diffuseColor.rgb;
  reflectedLight.directDiffuse += sssTint * (terminator * 0.07 * skinMask);
  reflectedLight.indirectDiffuse += sssTint * (0.02 * skinMask);
  float ndv = saturate(dot(normal, normalize(vViewPosition)));
  float fresnel = pow(1.0 - ndv, 4.0);
  reflectedLight.directSpecular *= 1.0 + (0.16 + 0.25 * fresnel) * skinMask;
  reflectedLight.indirectSpecular *= 1.0 + (0.12 + 0.18 * fresnel) * skinMask;
}`);
  };
  material.customProgramCacheKey = () => (hasPbrMaps ? "athlete-pbr-v2" : "athlete-v2");
}

export function athleteMaterial(source, { anisotropy = 1 } = {}) {
  for (const tex of [source.map, source.normalMap, source.roughnessMap, source.metalnessMap]) {
    if (tex) { tex.anisotropy = anisotropy; tex.needsUpdate = true; }
  }
  if (source.roughnessMap || source.normalMap || !source.map) {
    if (!source.roughnessMap) { source.metalness = 0; source.roughness = 0.9; }
    source.side = THREE.FrontSide;
    if (source.map) applyAthleteShader(source, { hasPbrMaps: true });
    return source;
  }
  const map = source.map;
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
    bumpScale: 0.22,
    side: THREE.FrontSide
  });
  applyAthleteShader(material, { hasPbrMaps: false });
  source.dispose();
  return material;
}
