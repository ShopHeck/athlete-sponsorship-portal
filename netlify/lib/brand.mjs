const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

function channelValues(hex) {
  if (!HEX_PATTERN.test(hex)) throw new Error(`invalid accent color: ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset + 1, offset + 3), 16));
}

function mix(first, second, amount) {
  const a = channelValues(first);
  const b = channelValues(second);
  const channels = a.map((value, index) => Math.round(value * (1 - amount) + b[index] * amount));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function deriveBrand(accent) {
  if (!HEX_PATTERN.test(accent)) throw new Error(`invalid accent color: ${accent}`);
  const dark = mix(accent, "#000000", 0.45);
  const hover = mix(accent, "#ffffff", 0.30);
  const payHover = mix(accent, "#ffffff", 0.38);
  const stroke = mix(accent, "#0b0f17", 0.55);
  const wash = mix(accent, "#0b0f17", 0.82);
  const panel = mix(accent, "#0b0f17", 0.92);
  return {
    accent,
    accentDark: dark,
    wash,
    accentHover: hover,
    accentPayHover: payHover,
    accentStroke: stroke,
    accentPanel: panel,
    accentGradient: wash
  };
}
