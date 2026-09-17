// Source: AI generated with GPT-5.6-Sol

import type {
  Box3DModule,
  b3BodyId,
  b3ShapeId,
  b3WorldId,
} from "box3d.js";
import * as THREE from "three";

export type MapVector = readonly [number, number, number];

export type TrenchBroomFace = {
  points: readonly [MapVector, MapVector, MapVector];
  texture: string;
  offset: readonly [number, number];
  rotation: number;
  scale: readonly [number, number];
};

export type TrenchBroomBrush = {
  faces: TrenchBroomFace[];
};

export type TrenchBroomEntity = {
  properties: Record<string, string>;
  brushes: TrenchBroomBrush[];
};

export type TrenchBroomMap = {
  entities: TrenchBroomEntity[];
};

export type MapCollisionObjects = {
  body: b3BodyId;
  shapes: b3ShapeId[];
};

export type MapBuildOptions = {
  /** Conversion from TrenchBroom units to metres. */
  unitsToMeters?: number;
};

type Token = {
  value: string;
  line: number;
};

type Plane = {
  normal: THREE.Vector3;
  distance: number;
};

type BrushGeometry = {
  vertices: THREE.Vector3[];
  faces: number[][];
};

const DEFAULT_UNITS_TO_METERS = 1 / 32;
const PLANE_EPSILON = 1e-4;
const VERTEX_EPSILON_SQ = 1e-8;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const character = source[index];

    if (character === "\n") {
      line++;
      index++;
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (character === '"') {
      const tokenLine = line;
      let value = "";
      index++;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\" && index + 1 < source.length) {
          index++;
          value += source[index];
        } else {
          value += source[index];
        }
        index++;
      }
      if (index >= source.length) {
        throw new Error(`Unterminated string on line ${tokenLine}`);
      }
      index++;
      tokens.push({ value, line: tokenLine });
      continue;
    }
    if ("{}()".includes(character)) {
      tokens.push({ value: character, line });
      index++;
      continue;
    }

    const tokenLine = line;
    const start = index;
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      !"{}()".includes(source[index]) &&
      !(source[index] === "/" && source[index + 1] === "/")
    ) {
      index++;
    }
    tokens.push({ value: source.slice(start, index), line: tokenLine });
  }

  return tokens;
}

/** Parse the Standard (Quake) TrenchBroom .map format. */
export function parseTrenchBroomMap(source: string): TrenchBroomMap {
  const tokens = tokenize(source);
  let cursor = 0;

  const peek = (): Token | undefined => tokens[cursor];
  const take = (): Token => {
    const token = tokens[cursor++];
    if (token === undefined) throw new Error("Unexpected end of map file");
    return token;
  };
  const expect = (expected: string): Token => {
    const token = take();
    if (token.value !== expected) {
      throw new Error(`Expected '${expected}' on line ${token.line}, got '${token.value}'`);
    }
    return token;
  };
  const number = (): number => {
    const token = take();
    const value = Number(token.value);
    if (!Number.isFinite(value)) {
      throw new Error(`Expected a number on line ${token.line}, got '${token.value}'`);
    }
    return value;
  };
  const vector = (): MapVector => {
    expect("(");
    const result: MapVector = [number(), number(), number()];
    expect(")");
    return result;
  };
  const face = (): TrenchBroomFace => ({
    points: [vector(), vector(), vector()],
    texture: take().value,
    offset: [number(), number()],
    rotation: number(),
    scale: [number(), number()],
  });
  const brush = (): TrenchBroomBrush => {
    expect("{");
    const faces: TrenchBroomFace[] = [];
    while (peek()?.value !== "}") {
      if (peek() === undefined) throw new Error("Unterminated brush");
      faces.push(face());
    }
    expect("}");
    if (faces.length < 4) {
      throw new Error("A convex brush must contain at least four faces");
    }
    return { faces };
  };

  const entities: TrenchBroomEntity[] = [];
  while (peek() !== undefined) {
    expect("{");
    const entity: TrenchBroomEntity = { properties: {}, brushes: [] };
    while (peek()?.value !== "}") {
      if (peek() === undefined) throw new Error("Unterminated entity");
      if (peek()?.value === "{") {
        entity.brushes.push(brush());
      } else {
        const key = take();
        const value = take();
        if (["{", "}", "(", ")"].includes(value.value)) {
          throw new Error(`Expected a property value on line ${value.line}`);
        }
        entity.properties[key.value] = value.value;
      }
    }
    expect("}");
    entities.push(entity);
  }

  return { entities };
}

function mapToWorld(point: THREE.Vector3, scale: number): THREE.Vector3 {
  // TrenchBroom is Z-up. Rotate -90 degrees around X to Three.js/Box3D Y-up.
  return new THREE.Vector3(point.x, point.z, -point.y).multiplyScalar(scale);
}

function intersectPlanes(a: Plane, b: Plane, c: Plane): THREE.Vector3 | null {
  const bCrossC = new THREE.Vector3().crossVectors(b.normal, c.normal);
  const denominator = a.normal.dot(bCrossC);
  if (Math.abs(denominator) < 1e-8) return null;

  return bCrossC
    .multiplyScalar(a.distance)
    .add(new THREE.Vector3().crossVectors(c.normal, a.normal).multiplyScalar(b.distance))
    .add(new THREE.Vector3().crossVectors(a.normal, b.normal).multiplyScalar(c.distance))
    .divideScalar(denominator);
}

function buildBrushGeometry(brush: TrenchBroomBrush, scale: number): BrushGeometry {
  const interior = new THREE.Vector3();
  for (const face of brush.faces) {
    for (const point of face.points) interior.add(new THREE.Vector3(...point));
  }
  interior.divideScalar(brush.faces.length * 3);

  const planes = brush.faces.map(({ points }) => {
    const a = new THREE.Vector3(...points[0]);
    const b = new THREE.Vector3(...points[1]);
    const c = new THREE.Vector3(...points[2]);
    const normal = new THREE.Vector3().crossVectors(
      b.clone().sub(a),
      c.clone().sub(a),
    );
    if (normal.lengthSq() < 1e-12) throw new Error("Brush contains a degenerate face");
    normal.normalize();
    let distance = normal.dot(a);

    // Normalize all planes so the brush interior is the negative half-space.
    if (normal.dot(interior) > distance) {
      normal.negate();
      distance = -distance;
    }
    return { normal, distance };
  });

  const mapVertices: THREE.Vector3[] = [];
  for (let a = 0; a < planes.length - 2; a++) {
    for (let b = a + 1; b < planes.length - 1; b++) {
      for (let c = b + 1; c < planes.length; c++) {
        const point = intersectPlanes(planes[a], planes[b], planes[c]);
        if (
          point === null ||
          planes.some((plane) => plane.normal.dot(point) - plane.distance > PLANE_EPSILON) ||
          mapVertices.some((vertex) => vertex.distanceToSquared(point) < VERTEX_EPSILON_SQ)
        ) {
          continue;
        }
        mapVertices.push(point);
      }
    }
  }

  if (mapVertices.length < 4) throw new Error("Brush planes do not form a closed convex volume");

  const faces = planes.map((plane) => {
    const indices = mapVertices
      .map((vertex, index) => ({ vertex, index }))
      .filter(({ vertex }) => Math.abs(plane.normal.dot(vertex) - plane.distance) < PLANE_EPSILON)
      .map(({ index }) => index);
    if (indices.length < 3) throw new Error("Brush contains a face with fewer than three vertices");

    const center = indices.reduce(
      (result, index) => result.add(mapVertices[index]),
      new THREE.Vector3(),
    ).divideScalar(indices.length);
    const axisU = new THREE.Vector3();
    if (Math.abs(plane.normal.x) < 0.9) axisU.set(1, 0, 0);
    else axisU.set(0, 1, 0);
    axisU.addScaledVector(plane.normal, -axisU.dot(plane.normal)).normalize();
    const axisV = new THREE.Vector3().crossVectors(plane.normal, axisU);

    return indices.sort((left, right) => {
      const leftDelta = mapVertices[left].clone().sub(center);
      const rightDelta = mapVertices[right].clone().sub(center);
      return Math.atan2(leftDelta.dot(axisV), leftDelta.dot(axisU)) -
        Math.atan2(rightDelta.dot(axisV), rightDelta.dot(axisU));
    });
  });

  return {
    vertices: mapVertices.map((point) => mapToWorld(point, scale)),
    faces,
  };
}

function allBrushGeometry(map: TrenchBroomMap, scale: number): BrushGeometry[] {
  return map.entities.flatMap((entity) =>
    entity.brushes.map((brush) => buildBrushGeometry(brush, scale)),
  );
}

/** Build a renderable Three.js group containing one mesh per convex brush. */
export function createMapObject3D(
  map: TrenchBroomMap,
  options: MapBuildOptions = {},
): THREE.Group {
  const scale = options.unitsToMeters ?? DEFAULT_UNITS_TO_METERS;
  const group = new THREE.Group();
  group.name = "TrenchBroom map";

  for (const [brushIndex, brush] of allBrushGeometry(map, scale).entries()) {
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

/** Build static Box3D convex-hull collision shapes for every map brush. */
export function createMapCollisionObjects(
  b3: Box3DModule,
  world: b3WorldId,
  map: TrenchBroomMap,
  options: MapBuildOptions = {},
): MapCollisionObjects {
  const scale = options.unitsToMeters ?? DEFAULT_UNITS_TO_METERS;
  const body = b3.b3CreateBody(world, b3.b3DefaultBodyDef());
  b3.b3Body_SetName(body, "TrenchBroom map");
  const shapes: b3ShapeId[] = [];

  for (const brush of allBrushGeometry(map, scale)) {
    const points = brush.vertices.flatMap((point) => point.toArray());
    const hull = b3.b3CreateHull(points);
    if (hull === null) throw new Error("Box3D could not create a hull for a map brush");
    shapes.push(b3.b3CreateHullShape(body, b3.b3DefaultShapeDef(), hull));
    hull.delete();
  }

  return { body, shapes };
}

/** Read an entity's TrenchBroom origin and convert it to world coordinates. */
export function getEntityWorldOrigin(
  entity: TrenchBroomEntity,
  options: MapBuildOptions = {},
): THREE.Vector3 | null {
  const origin = entity.properties.origin?.trim().split(/\s+/).map(Number);
  if (origin === undefined || origin.length !== 3 || origin.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return mapToWorld(new THREE.Vector3(origin[0], origin[1], origin[2]), options.unitsToMeters ?? DEFAULT_UNITS_TO_METERS);
}
