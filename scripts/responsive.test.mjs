import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const marketing = readFileSync(new URL("../public/marketing.js", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function navigation() {
  const listeners = {}, attributes = { "aria-expanded": "false" }, classes = new Set();
  const button = {
    hidden: true,
    getAttribute: name => attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, callback) => { listeners[`button:${name}`] = callback; },
    focus: () => { button.focused = true; },
  };
  const nav = {
    classList: { toggle: (name, open) => open ? classes.add(name) : classes.delete(name) },
    addEventListener: (name, callback) => { listeners[`nav:${name}`] = callback; },
  };
  vm.runInNewContext(marketing, {
    document: {
      querySelector: () => button,
      getElementById: id => id === "primaryNav" ? nav : null,
      addEventListener: (name, callback) => { listeners[`document:${name}`] = callback; },
    },
    window: { matchMedia: () => ({ addEventListener: (name, callback) => { listeners[`media:${name}`] = callback; } }) },
  });
  return { button, attributes, classes, listeners };
}

test("mobile menu toggles its visible state and accessible label together", () => {
  const { button, attributes, classes, listeners } = navigation();
  assert.equal(button.hidden, false);
  listeners["button:click"]();
  assert.equal(attributes["aria-expanded"], "true");
  assert.equal(button.textContent, "Close");
  assert.equal(classes.has("is-open"), true);
  listeners["button:click"]();
  assert.equal(attributes["aria-expanded"], "false");
  assert.equal(button.textContent, "Menu");
  assert.equal(classes.has("is-open"), false);
});

test("Escape closes the menu and returns focus to its toggle", () => {
  const { button, attributes, listeners } = navigation();
  listeners["button:click"]();
  listeners["document:keydown"]({ key: "Escape" });
  assert.equal(attributes["aria-expanded"], "false");
  assert.equal(button.focused, true);
});

test("navigation links and desktop breakpoint changes reset the mobile menu", () => {
  const { attributes, listeners } = navigation();
  listeners["button:click"]();
  listeners["nav:click"]({ target: { closest: () => ({}) } });
  assert.equal(attributes["aria-expanded"], "false");
  listeners["button:click"]();
  listeners["media:change"]();
  assert.equal(attributes["aria-expanded"], "false");
});

test("missing homepage elements are safe", () => {
  vm.runInNewContext(marketing, {
    document: { querySelector: () => null, getElementById: () => null },
  });
});

test("homepage sponsor board includes 18 distinct brands without adding HKA to apparel", () => {
  const homepage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const board = homepage.match(/<ul class="sponsor-wall">([\s\S]*?)<\/ul>/)[1];
  const brands = [...board.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)];
  assert.equal(brands.length, 18);
  assert.equal(new Set(brands.map(([, , name]) => name)).size, 18);
  for (const [, src] of brands) assert.ok(readFileSync(new URL(`../public${src}`, import.meta.url)).length);
  assert.equal(brands.filter(([, src, name]) => src.endsWith("/hka-usa-gold.png") && name === "HKA USA").length, 1);
  assert.match(homepage, /18 brands backing Michael Heckert/);
  assert.match(homepage, /<dd>18<\/dd><dt>Brands on the sponsor board<\/dt>/);
  const tenant = readFileSync(new URL("../tenants/michael-heckert.json", import.meta.url), "utf8");
  assert.doesNotMatch(tenant, /hka-usa|HKA USA/);
});

const scrollSource = viewer.match(/function scrollSelectedIntoView\(\) \{[\s\S]*?\n\}/)[0];
for (const [name, item, expected] of [
  ["above", { top: 50, bottom: 100 }, -50],
  ["below", { top: 400, bottom: 456 }, 56],
  ["visible", { top: 150, bottom: 206 }, 0],
  ["absent", null, 0],
]) {
  test(`selected ${name} item scrolls only the inventory, never the document`, () => {
    let scrolled = 0;
    const inventoryList = {
      querySelector: () => item && { getBoundingClientRect: () => item },
      getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      scrollBy: ({ top }) => { scrolled += top; },
    };
    vm.runInNewContext(`${scrollSource}\nscrollSelectedIntoView();`, { inventoryList });
    assert.equal(scrolled, expected);
  });
}

test("viewer allows vertical touch scrolling on narrow screens and resets on desktop", () => {
  const source = viewer.match(/const narrowViewport =[\s\S]*?\nsyncTouchScrolling\(\);/)[0];
  const canvas = { style: {} };
  let onChange;
  const media = { matches: true, addEventListener: (name, callback) => { onChange = callback; } };
  vm.runInNewContext(source, { canvas, window: { matchMedia: () => media } });
  assert.equal(canvas.style.touchAction, "pan-y");
  media.matches = false;
  onChange();
  assert.equal(canvas.style.touchAction, "none");
});

test("private studio scrolling and fixed-height breakpoints match the portal", () => {
  const portal = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../public/studio.css", import.meta.url), "utf8");
  const desktop = css => Number(css.match(/@media\(min-width:(\d+)px\) and \(min-height:600px\)/)[1]);
  const narrow = css => Number(css.match(/@media\(max-width:(\d+)px\)/)[1]);
  assert.equal(desktop(studio), desktop(portal));
  assert.equal(narrow(studio), narrow(portal));
  assert.equal(narrow(studio) + 1, desktop(studio));
});
