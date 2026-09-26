// Source: https://github.com/isaac-mason/box3d.js/blob/5d5a3af049cccd9948b2b55bac4342414af0ef64/examples/src/box3d-three.ts
// Modified with GPT-5.6-Sol

// MIT License
//
// Copyright (c) 2026 Isaac Mason
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Physics debug rendering for box3d worlds, bodies, and shapes. Production
// visuals remain independent; this module provides optional wireframe overlays
// and transform synchronization helpers for entity renderers.

import type { Box3DModule, b3AABB, b3BodyId, b3ShapeId, b3WorldId } from 'box3d.js';
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

// b3AABB is a flat mathcat Box3: [minX, minY, minZ, maxX, maxY, maxZ]
const HUGE_BOUNDS: b3AABB = [-1e9, -1e9, -1e9, 1e9, 1e9, 1e9];

// reused scratch for zero-alloc per-shape transform reads
const _p: [number, number, number] = [0, 0, 0];
const _q: [number, number, number, number] = [0, 0, 0, 1];
const PALETTE = [
  0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff, 0xc78bff, 0xff9f45, 0x22d3ee,
];

const shapeKey = (s: b3ShapeId): string =>
  `${s.index1}:${s.world0}:${s.generation}`;

// Static and moving bodies use distinct debug colors.
function colorFor(
  b3: Box3DModule,
  body: b3BodyId,
  dynamicIdx: number,
): THREE.Color {
  const isStatic =
    b3.b3Body_GetType(body).value === b3.b3BodyType.b3_staticBody.value;
  const color = new THREE.Color();
  if (isStatic) {
    color.setHex(0x22d3ee);
  } else {
    color.setHex(PALETTE[dynamicIdx % PALETTE.length]);
  }
  return color;
}

export type PhysicsDebugRenderer = {
  /** Add this to the Three.js scene or an entity's visual hierarchy. */
  readonly object3d: THREE.Object3D;
  /** Synchronize the debug visualization with Box3D. */
  update(): void;
};

function createDebugMaterial(color: THREE.Color): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Build Three.js geometry for one Box3D shape in body-local coordinates. */
export function createShapeDebugGeometry(
  b3: Box3DModule,
  shapeId: b3ShapeId,
): THREE.BufferGeometry | null {
  const type = b3.b3Shape_GetType(shapeId).value;

  if (type === b3.b3ShapeType.b3_sphereShape.value) {
    const sphere = b3.b3Shape_GetSphere(shapeId);
    const geometry = new THREE.SphereGeometry(sphere.radius, 20, 14);
    geometry.translate(sphere.center[0], sphere.center[1], sphere.center[2]);
    return geometry;
  }

  if (type === b3.b3ShapeType.b3_capsuleShape.value) {
    const capsule = b3.b3Shape_GetCapsule(shapeId);
    const { center1, center2 } = capsule;
    const axis = new THREE.Vector3(
      center2[0] - center1[0],
      center2[1] - center1[1],
      center2[2] - center1[2],
    );
    const geometry = new THREE.CapsuleGeometry(capsule.radius, axis.length(), 8, 16);
    geometry.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        axis.clone().normalize(),
      ),
    );
    geometry.translate(
      (center1[0] + center2[0]) / 2,
      (center1[1] + center2[1]) / 2,
      (center1[2] + center2[2]) / 2,
    );
    return geometry;
  }

  if (type === b3.b3ShapeType.b3_hullShape.value) {
    const flat = b3.b3Shape_GetHullVertices(shapeId);
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < flat.length; i += 3) {
      points.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
    }
    return new ConvexGeometry(points);
  }

  // Mesh, heightfield, and compound data cannot currently be read back through
  // the generic Box3D shape API.
  return null;
}

/** Copy a Box3D body's world transform onto a Three.js object. */
export function syncObjectToBody(
  b3: Box3DModule,
  body: b3BodyId,
  object3d: THREE.Object3D,
): void {
  b3.b3Body_GetPosition(_p, body);
  b3.b3Body_GetRotation(_q, body);
  object3d.position.set(_p[0], _p[1], _p[2]);
  object3d.quaternion.set(_q[0], _q[1], _q[2], _q[3]);
}

/** Create a targeted debug visualization for a single body's current shapes. */
export function createBodyDebugRenderer(
  b3: Box3DModule,
  body: b3BodyId,
): PhysicsDebugRenderer {
  const group = new THREE.Group();
  group.name = "Box3D body debug renderer";
  group.renderOrder = 1000;
  const material = createDebugMaterial(colorFor(b3, body, 0));
  const shapes = b3.b3Body_GetShapes(body);

  for (const shape of shapes) {
    const geometry = createShapeDebugGeometry(b3, shape);
    if (geometry !== null) group.add(new THREE.Mesh(geometry, material));
  }
  shapes.delete();

  const update = (): void => syncObjectToBody(b3, body, group);
  update();
  return { object3d: group, update };
}

/** Create a toggleable debug overlay that discovers every shape in the world. */
export function createPhysicsDebugRenderer(
  b3: Box3DModule,
  world: b3WorldId,
): PhysicsDebugRenderer {
  const group = new THREE.Group();
  group.name = "Box3D world debug renderer";
  group.renderOrder = 1000;
  const meshes = new Map<string, THREE.Mesh>();
  const filter = b3.b3DefaultQueryFilter();
  const seen = new Set<string>();
  let colorIdx = 0;


  function update(): void {
    seen.clear();

    b3.b3World_OverlapAABB(world, HUGE_BOUNDS, filter, (shapeId: b3ShapeId) => {
      const key = shapeKey(shapeId);
      seen.add(key);

      const body = b3.b3Shape_GetBody(shapeId);

      let mesh = meshes.get(key);
      if (mesh === undefined) {
        const geometry = createShapeDebugGeometry(b3, shapeId);
        if (geometry === null) return true; // unsupported shape — example renders it
        const material = createDebugMaterial(colorFor(b3, body, colorIdx));
        // Only advance the bright palette for dynamic/kinematic bodies.
        if (b3.b3Body_GetType(body).value !== b3.b3BodyType.b3_staticBody.value)
          colorIdx++;
        mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 1000;
        meshes.set(key, mesh);
        group.add(mesh);
      }

      syncObjectToBody(b3, body, mesh);
      mesh.visible = true;
      return true; // continue enumeration
    });

    // hide shapes that were destroyed since last frame
    for (const [key, mesh] of meshes) {
      if (!seen.has(key)) mesh.visible = false;
    }
  }

  return { object3d: group, update };
}
