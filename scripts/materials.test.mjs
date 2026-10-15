import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { athleteMaterial, CLOTH_ROUGHNESS } from "../public/materials.js";

test("models with their own PBR maps keep their material and gain skin subsurface shader hooks", () => {
  const source = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), roughnessMap: new THREE.Texture(), normalMap: new THREE.Texture() });
  assert.equal(athleteMaterial(source, { anisotropy: 8 }), source);
  assert.equal(source.map.anisotropy, 8);
  assert.equal(source.normalMap.anisotropy, 8);
  assert.equal(source.roughnessMap.anisotropy, 8);
  assert.equal(source.side, THREE.FrontSide);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  source.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /sssTint/);
  assert.match(shader.fragmentShader, /microWeave/);
});

test("a bare colour atlas becomes skin-aware cloth: every shader hook it patches exists in three's physical shader", () => {
  const map = new THREE.Texture();
  const material = athleteMaterial(new THREE.MeshStandardMaterial({ map }), { anisotropy: 4 });
  assert.ok(material.isMeshPhysicalMaterial);
  assert.equal(material.map, map);
  assert.equal(material.bumpMap, map, "the albedo's own folds drive the cloth relief");
  assert.equal(material.roughness, CLOTH_ROUGHNESS);
  assert.equal(material.metalness, 0);
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  const before = shader.fragmentShader;
  material.onBeforeCompile(shader);
  for (const hook of ["#include <common>", "#include <roughnessmap_fragment>", "#include <normal_fragment_maps>", "#include <lights_physical_fragment>"]) {
    assert.ok(before.includes(hook), `three's physical shader must still contain ${hook}`);
  }
  assert.match(shader.fragmentShader, /float skinMask/);
  assert.match(shader.fragmentShader, /roughnessFactor = mix\(roughnessFactor, skinRoughness, skinMask\)/);
  assert.match(shader.fragmentShader, /material\.sheenColor \*= \(1\.0 - skinMask\) \* diffuseColor\.rgb/);
  assert.ok(shader.uniforms.skinRoughness.value < CLOTH_ROUGHNESS, "skin is glossier than cloth");
});
