import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/Addons.js";
import { type Box3DModule } from "box3d.js";
import { createPhysicsDebugRenderer } from "./box3d-three";
import { createHuman } from "./ragdoll";

import {
  createMapCollisionObjects,
  createMapObject3D,
  getEntityWorldOrigin,
  parseTrenchBroomMap,
} from "./trenchbroom-map";

const FIELD_OF_VIEW = 75;
const CLIP_NEAR = 0.1;
const CLIP_FAR = 1000;

export const Game = async ({
  b3,
  container,
}: {
  b3: Box3DModule;
  container: HTMLElement;
}) => {
  let running = false;

  const levelUrl = new URL("./assets/level1.map", import.meta.url);
  const levelResponse = await fetch(levelUrl);
  if (!levelResponse.ok) {
    throw new Error(
      `Failed to load map '${levelUrl}': ${levelResponse.status} ${levelResponse.statusText}`,
    );
  }
  const level1Source = await levelResponse.text();

  const world = b3.b3CreateWorld({
    ...b3.b3DefaultWorldDef(),
    gravity: [0, -9.8, 0],
  });

  const map = parseTrenchBroomMap(level1Source);
  createMapCollisionObjects(b3, world, map);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  const camera = new THREE.PerspectiveCamera(
    FIELD_OF_VIEW,
    window.innerWidth / window.innerHeight,
    CLIP_NEAR,
    CLIP_FAR,
  );
  camera.position.set(0, 3, 9);
  camera.lookAt(0, 3, 0);

  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  new OrbitControls(camera, renderer.domElement);

  const debugElement = document.createElement("div");
  debugElement.id = "debug";
  container.appendChild(debugElement);

  const sun = new THREE.DirectionalLight("#fff2dc", 2.5);
  sun.position.set(6, 11, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 2;
  const sc = sun.shadow.camera;
  sc.near = 1;
  sc.far = 34;
  sc.left = -12;
  sc.right = 12;
  sc.top = 12;
  sc.bottom = -12;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbddcff, 0x302820, 0.8));
  scene.add(createMapObject3D(map));

  const physicsDebug = createPhysicsDebugRenderer(b3, world);
  scene.add(physicsDebug.object3d);

  map.entities.forEach((entity) => {
    if (entity.properties.classname === "info_player_start") {
      const position = getEntityWorldOrigin(entity);
      if (position) {
        createHuman(b3, world, [position.x, position.y, position.z], 1, 0.05);
      } else {
        throw new Error("Player Start has no position");
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    if (event.code === "Space") running = !running;
    if (event.code === "KeyP") {
      physicsDebug.object3d.visible = !physicsDebug.object3d.visible;
      if (physicsDebug.object3d.visible) physicsDebug.update();
    }
  });

  physicsDebug.object3d.visible = true;
  physicsDebug.update();

  const debugInfo = ({ dt }: { dt: number }) =>
    [
      `FPS: ${Math.round(1000 / dt)}`,
      `Simulation: ${running ? "running" : "paused"} (Space)`,
      `Physics debug: ${physicsDebug.object3d.visible ? "on" : "off"} (P)`,
    ].join(" | ");

  let lastTime = 0;
  const animate = (time: number) => {
    const dt = time - lastTime;
    lastTime = time;

    if (running) {
      b3.b3World_Step(world, 1 / 60, 4);
      if (physicsDebug.object3d.visible) physicsDebug.update();
    }
    renderer.render(scene, camera);
    debugElement.innerText = debugInfo({ dt });
  };
  renderer.setAnimationLoop(animate);
};
