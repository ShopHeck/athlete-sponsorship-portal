// Meshy's animation export can merge material slots. Keep the rig's surfaces and copy only motion tracks.
export function transferRigAnimations(rig, animated) {
  const animations = animated.getRoot().listAnimations();
  if (!animations.length) throw new Error("Animation export contains no clips.");
  const targets = new Map();
  for (const node of rig.getRoot().listNodes()) {
    const name = node.getName();
    const matches = targets.get(name) || [];
    matches.push(node);
    targets.set(name, matches);
  }
  const nodes = new Map();
  const close = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 1e-3);
  for (const animation of animations) for (const channel of animation.listChannels()) {
    if (!["translation", "rotation", "scale"].includes(channel.getTargetPath())) {
      throw new Error("Rig transfer supports only skeletal transform tracks.");
    }
    for (let source = channel.getTargetNode(); source; source = source.getParentNode()) {
      if (nodes.has(source)) continue;
      const matches = targets.get(source.getName()) || [];
      if (!source.getName() || matches.length !== 1) {
        throw new Error(`Rig transfer requires a unique target for ${source.getName() || "unnamed node"}.`);
      }
      const target = matches[0], rotation = source.getRotation(), parent = source.getParentNode()?.getName();
      if (parent !== target.getParentNode()?.getName() ||
          !close(source.getTranslation(), target.getTranslation()) ||
          !close(source.getScale(), target.getScale()) ||
          (!close(rotation, target.getRotation()) && !close(rotation.map(v => -v), target.getRotation()))) {
        throw new Error(`Rig transfer refused: bind transforms differ for ${source.getName()}.`);
      }
      nodes.set(source, target);
    }
  }
  const buffer = rig.getRoot().listBuffers()[0] || rig.createBuffer();
  const accessors = new Map();
  const copyAccessor = source => {
    if (!source?.getArray()) throw new Error("Animation accessor has no data.");
    if (!accessors.has(source)) {
      accessors.set(source, rig.createAccessor(source.getName()).setType(source.getType())
        .setArray(source.getArray().slice()).setNormalized(source.getNormalized()).setSparse(source.getSparse())
        .setExtras(structuredClone(source.getExtras())).setBuffer(buffer));
    }
    return accessors.get(source);
  };
  for (const animation of [...rig.getRoot().listAnimations()]) animation.dispose();
  for (const source of animations) {
    const clip = rig.createAnimation(source.getName()).setExtras(structuredClone(source.getExtras()));
    const samplers = new Map();
    for (const sampler of source.listSamplers()) {
      const copy = rig.createAnimationSampler(sampler.getName()).setInterpolation(sampler.getInterpolation())
        .setInput(copyAccessor(sampler.getInput())).setOutput(copyAccessor(sampler.getOutput()))
        .setExtras(structuredClone(sampler.getExtras()));
      samplers.set(sampler, copy);
      clip.addSampler(copy);
    }
    for (const channel of source.listChannels()) {
      clip.addChannel(rig.createAnimationChannel(channel.getName()).setTargetNode(nodes.get(channel.getTargetNode()))
        .setTargetPath(channel.getTargetPath()).setSampler(samplers.get(channel.getSampler()))
        .setExtras(structuredClone(channel.getExtras())));
    }
  }
  return animations.length;
}

export function sameUvLayout(a, b) {
  const tolerance = 1e-6;
  const valid = triangles => triangles.every(t => t.length === 6 && t.every(Number.isFinite));
  if (a.length !== b.length || !valid(a) || !valid(b)) return false;
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const close = (t, u) => permutations.some(order => t.every((value, c) =>
    Math.abs(value - u[order[Math.floor(c / 2)] * 2 + c % 2]) <= tolerance));
  if (a.every((t, i) => close(t, b[i]))) return true;
  const cell = t => [
    Math.floor((t[0] + t[2] + t[4]) / (6 * tolerance)),
    Math.floor((t[1] + t[3] + t[5]) / (6 * tolerance))
  ];
  const key = t => cell(t).join(",");
  const buckets = new Map(), free = new Map();
  b.forEach((t, i) => {
    const k = key(t);
    if (!buckets.has(k)) {
      buckets.set(k, []);
      free.set(k, new Set());
    }
    buckets.get(k).push(i);
    free.get(k).add(i);
  });
  function* candidates(t) {
    const [x, y] = cell(t), keys = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(`${x + dx},${y + dy}`);
    for (const k of keys) yield* (free.get(k) || []);
    for (const k of keys) yield* (buckets.get(k) || []);
  }
  const owners = new Int32Array(b.length).fill(-1);
  for (let i = 0; i < a.length; i++) {
    const queue = [i], previous = new Map([[i, null]]), seen = new Set();
    let matched = false;
    // Reassign earlier matches when near-duplicate triangles have overlapping tolerance ranges.
    for (let head = 0; head < queue.length && !matched; head++) {
      const current = queue[head];
      for (const j of candidates(a[current])) {
        if (seen.has(j) || !close(a[current], b[j])) continue;
        seen.add(j);
        if (owners[j] === -1) {
          free.get(key(b[j])).delete(j);
          let target = j, source = current;
          while (true) {
            owners[target] = source;
            const link = previous.get(source);
            if (!link) break;
            [source, target] = link;
          }
          matched = true;
          break;
        }
        const owner = owners[j];
        if (!previous.has(owner)) {
          previous.set(owner, [current, j]);
          queue.push(owner);
        }
      }
    }
    if (!matched) return false;
  }
  return true;
}
