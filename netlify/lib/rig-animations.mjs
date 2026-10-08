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
