import { readFileSync } from "node:fs";
import * as THREE from "three";
import { levelSolids } from "@stairs/shared/level-entities";
import { loadLevel } from "@stairs/shared/level";
import { visibleFaces } from "../game/src/brush-csg";
for (const id of ["level1", "level2", "level3"]) {
  const level = loadLevel(readFileSync(`../shared/levels/${id}.map`, "utf8"));
  const brushes = levelSolids(level.map).statics.flatMap((s) => s.brushes);
  const faces = visibleFaces(brushes);
  let tiny = 0, flipped = 0, degenerateTris = 0, tris = 0;
  for (const f of faces) {
    const v = f.vertices;
    const n = new THREE.Vector3();
    for (let i = 0; i < v.length; i++) { const a = v[i], b = v[(i + 1) % v.length]; n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y); }
    const area = n.length() / 2;
    if (area < 1e-4) tiny++;
    n.normalize();
    for (let i = 1; i < v.length - 1; i++) {
      tris++;
      const tn = new THREE.Vector3().crossVectors(v[i].clone().sub(v[0]), v[i + 1].clone().sub(v[0]));
      if (tn.length() < 1e-9) degenerateTris++;
      else if (tn.normalize().dot(n) < 0.99) flipped++;
    }
  }
  console.log(`${id}: ${faces.length} pieces, ${tiny} with area < 1 cm², ${tris} triangles: ${degenerateTris} degenerate, ${flipped} not facing the piece's way`);
}
