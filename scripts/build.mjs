import { cpSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderPortal } from "../netlify/lib/render.mjs";
import { validateConfig } from "../netlify/lib/validate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tenantsDirectory = path.join(root, "tenants");
const template = readFileSync(path.join(root, "src/index.template.html"), "utf8");
const generatedPlatform = path.join(root, "netlify/lib/platform.generated.json");
const mediapipeSource = path.join(root, "node_modules/@mediapipe/tasks-vision");
const mediapipeTarget = path.join(root, "public/vendor/mediapipe");
const tenantFiles = readdirSync(tenantsDirectory)
  .filter((filename) => filename.endsWith(".json"))
  .sort();

if (tenantFiles.length === 0) throw new Error("tenants/ must contain at least one JSON config");

const tenants = tenantFiles.map((filename) => {
  const config = JSON.parse(readFileSync(path.join(tenantsDirectory, filename), "utf8"));
  return validateConfig(config, filename);
});
const version = String(process.env.COMMIT_REF || process.env.DEPLOY_ID || Date.now()).slice(0, 10);
const platformUrl = (process.env.PLATFORM_URL || "https://athletes.michaelheckert.com").replace(/\/+$/, "");

for (const config of tenants) {
  const html = renderPortal(config, {
    template,
    version,
    portalUrl: `${platformUrl}/${config.slug}`
  });
  if (!html.includes('id="portal-config"')) {
    throw new Error(`render smoke check failed for tenant ${config.slug}`);
  }
}

const platform = {
  version,
  template,
  tenants: Object.fromEntries(tenants.map((config) => [config.slug, config]))
};
writeFileSync(generatedPlatform, `${JSON.stringify(platform, null, 2)}\n`);
mkdirSync(mediapipeTarget, { recursive: true });
copyFileSync(path.join(mediapipeSource, "vision_bundle.mjs"), path.join(mediapipeTarget, "vision_bundle.mjs"));
cpSync(path.join(mediapipeSource, "wasm"), path.join(mediapipeTarget, "wasm"), { recursive: true });
const threeSource = path.join(root, "node_modules/three");
const threeVersion = JSON.parse(readFileSync(path.join(threeSource, "package.json"), "utf8")).version;
const threeTarget = path.join(root, `public/vendor/three-${threeVersion}`);
mkdirSync(threeTarget, { recursive: true });
copyFileSync(path.join(threeSource, "build/three.module.min.js"), path.join(threeTarget, "three.module.js"));
for (const addon of [
  "controls/OrbitControls.js", "environments/RoomEnvironment.js", "geometries/DecalGeometry.js",
  "loaders/GLTFLoader.js", "loaders/DRACOLoader.js", "utils/BufferGeometryUtils.js",
  "libs/draco/draco_decoder.js", "libs/draco/draco_decoder.wasm", "libs/draco/draco_wasm_wrapper.js"
]) {
  const target = path.join(threeTarget, "addons", addon);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(threeSource, "examples/jsm", addon), target);
}
console.log(`Built tenant registry with ${tenants.length} tenants (version ${version}).`);
