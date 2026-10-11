import assert from "node:assert/strict";
import test from "node:test";
import { FAST_MS, GRACE_MS, RETRY_FAILED_MS, SLOW_MS, UP_COOLDOWN_MS, VERY_SLOW_MS, nextRatio, resolutionPolicy, settle } from "../public/resolution.js";

test("retina screens stay crisp: slow frames stop at 1.5x unless they are very slow", () => {
  const state = resolutionPolicy(3);
  assert.equal(state.max, 2);
  let now = 10_000;
  assert.equal(nextRatio(state, SLOW_MS + 5, now), 1.75);
  now += GRACE_MS;
  assert.equal(nextRatio(state, SLOW_MS + 5, now), 1.5);
  now += GRACE_MS;
  assert.equal(nextRatio(state, SLOW_MS + 5, now), null, "1.5x is the floor for merely slow frames");
  assert.equal(nextRatio(state, VERY_SLOW_MS + 5, now), 1.25);
  now += GRACE_MS;
  assert.equal(nextRatio(state, VERY_SLOW_MS + 5, now), 1);
  now += GRACE_MS;
  assert.equal(nextRatio(state, VERY_SLOW_MS + 5, now), null, "never below 1x");
});

test("resolution climbs back once frames are fast, without bouncing straight into a level that failed", () => {
  const state = resolutionPolicy(2);
  let now = 10_000;
  assert.equal(nextRatio(state, SLOW_MS + 5, now), 1.75);
  now += UP_COOLDOWN_MS;
  assert.equal(nextRatio(state, FAST_MS, now), null, "2x was just too slow");
  now = 10_000 + RETRY_FAILED_MS;
  assert.equal(nextRatio(state, FAST_MS, now), 2);
  assert.equal(state.ratio, 2);
});

test("hitches right after load, resize or a tab switch are ignored", () => {
  const state = resolutionPolicy(2);
  settle(state, 1000);
  assert.equal(nextRatio(state, 200, 1000 + GRACE_MS - 1), null);
  assert.equal(nextRatio(state, 200, 1000 + GRACE_MS), 1.75);
  const plain = resolutionPolicy(1);
  assert.equal(nextRatio(plain, 200, 50_000), null, "a 1x screen has nowhere lower to go");
});
