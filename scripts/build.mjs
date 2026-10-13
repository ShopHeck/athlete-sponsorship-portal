import { createHash } from "node:crypto";
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
const tenantSources = readdirSync(tenantsDirectory)
  .filter((filename) => filename.endsWith(".json"))
  .map((filename) => ({ directory: tenantsDirectory, filename }));
if (process.env.INCLUDE_TEST_TENANTS === "1") {
  const fixturesDirectory = path.join(root, "scripts/fixtures/tenants");
  tenantSources.push(...readdirSync(fixturesDirectory)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => ({ directory: fixturesDirectory, filename })));
}
tenantSources.sort((a, b) => a.filename.localeCompare(b.filename));

if (tenantSources.length === 0) throw new Error("tenants/ must contain at least one JSON config");

const tenants = tenantSources.map(({ directory, filename }) => {
  const config = JSON.parse(readFileSync(path.join(directory, filename), "utf8"));
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
const threeMin = readFileSync(path.join(threeSource, "build/three.module.min.js"), "utf8");
writeFileSync(path.join(threeTarget, "three.module.js"), `${threeMin.trimEnd()}\n//# sourceMappingURL=three.module.js.map\n`);
writeFileSync(path.join(threeTarget, "three.module.js.map"), JSON.stringify({
  version: 3,
  file: "three.module.js",
  sources: ["three.module.js"],
  names: [],
  mappings: "AAAA"
}));
for (const addon of [
  "controls/OrbitControls.js", "environments/RoomEnvironment.js", "geometries/DecalGeometry.js",
  "loaders/GLTFLoader.js", "loaders/DRACOLoader.js", "utils/BufferGeometryUtils.js",
  "libs/draco/draco_decoder.js", "libs/draco/draco_decoder.wasm", "libs/draco/draco_wasm_wrapper.js"
]) {
  const target = path.join(threeTarget, "addons", addon);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(threeSource, "examples/jsm", addon), target);
}
const marketingCssHash = createHash("sha256")
  .update(readFileSync(path.join(root, "public/marketing.css")))
  .digest("hex")
  .slice(0, 12);
for (const rel of ["public/index.html", "public/privacy/index.html", "public/terms/index.html"]) {
  const htmlPath = path.join(root, rel);
  const current = readFileSync(htmlPath, "utf8");
  const updated = current.replace(/\/marketing\.css(?:\?v=[a-f0-9]+)?/g, `/marketing.css?v=${marketingCssHash}`);
  if (updated !== current) writeFileSync(htmlPath, updated);
}
console.log(`Built tenant registry with ${tenants.length} tenants (version ${version}).`);
