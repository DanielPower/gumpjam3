import * as THREE from "three";
import { mapBrushGeometry, type MapBuildOptions, type TrenchBroomMap } from "@stairs/shared/trenchbroom-map";

/** Build a renderable Three.js group containing one mesh per convex brush. */
export function createMapObject3D(
  map: TrenchBroomMap,
  options: MapBuildOptions = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = "TrenchBroom map";

  for (const [brushIndex, brush] of mapBrushGeometry(map, options).entries()) {
    const positions: number[] = [];
    for (const face of brush.faces) {
      for (let index = 1; index < face.length - 1; index++) {
        for (const vertexIndex of [face[0], face[index], face[index + 1]]) {
          positions.push(...brush.vertices[vertexIndex].toArray());
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0x78909c,
      roughness: 0.85,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Map brush ${brushIndex}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}
