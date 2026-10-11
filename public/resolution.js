// Adaptive render resolution. The old rule stepped the pixel ratio down after any slow stretch and never back up, so a
// single hitch (shader compile, the 4K texture upload, a busy tab) left retina screens rendering at 1x for good: the
// athlete looked pixelated. This policy keeps hi-DPI screens at 1.5x or better unless frames are badly slow, ignores the
// hitches right after load, resize or a return to the tab, and climbs back once frames are fast again.
export const STEP = 0.25;
export const SLOW_MS = 26;       // median frame time that costs a step down
export const VERY_SLOW_MS = 45;  // only this slow may go below the crisp floor
export const FAST_MS = 18;       // at or under one 60 Hz frame: there is headroom to step back up
export const GRACE_MS = 3000;    // ignore frames this long after load, resize or returning to the tab
export const UP_COOLDOWN_MS = 15000;
export const RETRY_FAILED_MS = 60000;

export function resolutionPolicy(devicePixelRatio = 1) {
  const max = Math.min(Math.max(devicePixelRatio, 1), 2);
  return { max, floor: Math.min(max, 1.5), ratio: max, settleUntil: 0, changedAt: 0, failed: null };
}

// Returns the new ratio for one window's median frame time (mutating `state`), or null to keep the current one.
export function nextRatio(state, median, now) {
  if (now < state.settleUntil) return null;
  const { ratio } = state;
  if (median > SLOW_MS) {
    const lowest = median > VERY_SLOW_MS ? 1 : state.floor;
    if (ratio <= lowest + 1e-9) return null;
    state.failed = { ratio, at: now };
    // Fractional screens (1.6x, 1.8x) clamp to the floor rather than skipping a step that would overshoot it.
    return change(state, Math.max(lowest, ratio - STEP), now);
  }
  if (median <= FAST_MS && ratio < state.max && now - state.changedAt >= UP_COOLDOWN_MS) {
    const up = Math.min(state.max, ratio + STEP);
    // Do not bounce straight back to a level that was just too slow.
    if (state.failed && up >= state.failed.ratio - 1e-9 && now - state.failed.at < RETRY_FAILED_MS) return null;
    return change(state, up, now);
  }
  return null;
}

// After load, resize or a return to the tab, frames are briefly slow for reasons resolution cannot fix.
export function settle(state, now) {
  state.settleUntil = now + GRACE_MS;
}

function change(state, ratio, now) {
  state.ratio = ratio;
  state.changedAt = now;
  state.settleUntil = now + GRACE_MS;
  return ratio;
}
