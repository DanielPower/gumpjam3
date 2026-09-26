import * as THREE from "three";
import { levelSolids } from "@stairs/shared/level-entities";
import type { BrushGeometry, TrenchBroomMap } from "@stairs/shared/trenchbroom-map";

const DEFAULT_COLOR = 0x78909c;

/** Colours for texture names used in the level maps; anything else is slate grey. */
const TEXTURE_COLORS: Record<string, number> = {
  concrete: 0xa9aeb2,
  pavement: 0xc9c1ad,
  grass: 0x6aa84f,
  asphalt: 0x3d4148,
  stripe_yellow: 0xf2c230,
  stripe_white: 0xeeeeee,
  brick: 0xa4553e,
  wood: 0x9c6b3f,
  metal: 0x8d99a6,
  glass: 0x86bfe0,
  rubber: 0x2a2a2a,
  dark: 0x16181b,
  trampoline: 0x2f9be0,
  red: 0xd9443b,
  blue: 0x3b78d8,
  yellow: 0xf2b830,
  white: 0xf2f2f2,
  stone: 0xd8cbb3,
  stone_dark: 0x9c8f7a,
  paving: 0xc4b59a,
  rock: 0x7a6e62,
  marble: 0xeee8dc,
  gold: 0xd9a93a,
  terracotta: 0xc0643f,
  iron: 0x3a3d42,
  lantern: 0xffcf6b,
  water: 0x3f8fc9,
  bark: 0x6b4a2f,
  leaves: 0x4f8f3a,
};

const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });

/** One mesh for a set of brushes, coloured per face from its texture name. */
function brushMesh(brushes: BrushGeometry[]) {
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  for (const brush of brushes) {
    brush.faces.forEach((face, faceIndex) => {
      color.setHex(TEXTURE_COLORS[brush.textures[faceIndex]] ?? DEFAULT_COLOR, THREE.SRGBColorSpace);
      for (let index = 1; index < face.length - 1; index++) {
        for (const vertexIndex of [face[0], face[index], face[index + 1]]) {
          positions.push(...brush.vertices[vertexIndex].toArray());
          colors.push(color.r, color.g, color.b);
        }
      }
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export type LevelObjects = {
  /** Static level geometry. */
  statics: THREE.Group;
  /** One object per moving entity, in the same order as Simulation.movers, to sync to their bodies. */
  movers: THREE.Object3D[];
};

/** Build renderable objects for a level's static and moving geometry. */
export function createLevelObjects(map: TrenchBroomMap): LevelObjects {
  const { statics, movers } = levelSolids(map);
  const group = new THREE.Group();
  group.name = "Level";
  group.add(brushMesh(statics.flatMap((solid) => solid.brushes)));
  return { statics: group, movers: movers.map((mover) => brushMesh(mover.brushes)) };
}
