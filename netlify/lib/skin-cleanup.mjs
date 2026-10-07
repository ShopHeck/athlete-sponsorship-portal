// Meshy's auto-rigger blends weights across body parts that touch in the scan pose (gloves resting on the trunks,
// elbows on the flanks), which tears and stretches those areas once the arms move. Each such vertex is handed
// wholly to whichever limb's capsule it sits inside, so the hand and the hip it rested on separate cleanly.
const ARM = /^(Left|Right)(ForeArm|Hand)$/;
const BODY = /^(Hips|Spine02|Spine01|(Left|Right)(UpLeg|Leg))$/;
// Capsule radius as a share of standing height.
const RADIUS = { ForeArm: 0.028, Hand: 0.04, Hips: 0.085, Spine02: 0.085, Spine01: 0.085, UpLeg: 0.05, Leg: 0.035 };
const NEXT = { ForeArm: "Hand", Hips: "Spine01", Spine02: "Spine01", Spine01: "Spine", UpLeg: "Leg", Leg: "Foot" };

function invertAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const [tx, ty, tz] = [m[12], m[13], m[14]];
  return [-(r[0] * tx + r[3] * ty + r[6] * tz), -(r[1] * tx + r[4] * ty + r[7] * tz), -(r[2] * tx + r[5] * ty + r[8] * tz)];
}

function segmentDistance(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

export function separateLimbWeights(document) {
  let changed = 0;
  for (const skin of document.getRoot().listSkins()) {
    const joints = skin.listJoints();
    const names = joints.map((joint) => joint.getName());
    const ibm = skin.getInverseBindMatrices();
    if (!ibm) continue;
    const rest = joints.map((_, i) => invertAffine(ibm.getElement(i, [])));
    const at = (name) => rest[names.indexOf(name)];
    const heights = rest.map((p) => p[1]);
    const height = Math.max(...heights) - Math.min(...heights) || 1.8;
    // Capsule per relevant joint: segment towards its child; the hand extends along the forearm direction.
    const capsules = names.map((name, i) => {
      if (!ARM.test(name) && !BODY.test(name)) return null;
      const side = name.match(/^(Left|Right)/)?.[1] || "";
      const part = name.slice(side.length);
      const a = rest[i];
      let b = at(side + NEXT[part]) || at(NEXT[part]);
      if (part === "Hand") {
        const fore = at(`${side}ForeArm`);
        b = [0, 1, 2].map((k) => a[k] + (a[k] - fore[k]) * 0.35);
      }
      if (!b) return null;
      return { a, b, r: RADIUS[part] * height, arm: ARM.test(name) };
    });
    for (const mesh of document.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute("JOINTS_0"), W = prim.getAttribute("WEIGHTS_0"), P = prim.getAttribute("POSITION");
      if (!J || !W || !P) continue;
      const j = [], w = [], p = [];
      for (let v = 0; v < J.getCount(); v++) {
        J.getElement(v, j); W.getElement(v, w);
        let armW = 0, bodyW = 0;
        for (let k = 0; k < 4; k++) {
          const cap = capsules[j[k]];
          if (!cap || !w[k]) continue;
          if (cap.arm) armW += w[k]; else bodyW += w[k];
        }
        if (armW < 0.05 || bodyW < 0.05) continue;
        P.getElement(v, p);
        let armFit = Infinity, bodyFit = Infinity;
        for (let k = 0; k < 4; k++) {
          const cap = capsules[j[k]];
          if (!cap || !w[k]) continue;
          const fit = segmentDistance(p, cap.a, cap.b) / cap.r;
          if (cap.arm) armFit = Math.min(armFit, fit); else bodyFit = Math.min(bodyFit, fit);
        }
        const dropArm = bodyFit <= armFit;
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const cap = capsules[j[k]];
          if (cap && cap.arm === dropArm) w[k] = 0;
          total += w[k];
        }
        if (!total) continue;
        W.setElement(v, w.map((x) => x / total));
        changed++;
      }
    }
  }
  return changed;
}
