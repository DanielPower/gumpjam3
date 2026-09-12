import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/Addons.js";
import { type Box3DModule } from 'box3d.js';
import { createWorldRenderer } from "./box3d-three";
import { createHuman } from "./ragdoll";

const FIELD_OF_VIEW = 75;
const CLIP_NEAR = 0.1;
const CLIP_FAR = 1000;

export const Game = ({ b3, container }: { b3: Box3DModule, container: HTMLElement }) => {
  let running = false;

  const world = b3.b3CreateWorld({
    ...b3.b3DefaultWorldDef(),
    gravity: [0, -9.8, 0],
  });

  const ground = b3.b3CreateBody(world, {
    ...b3.b3DefaultBodyDef(),
    position: [0, -0.5, 0]
  });
  b3.b3CreateBoxShape(ground, b3.b3DefaultShapeDef(), 20, 0.5, 20);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, window.innerWidth / window.innerHeight, CLIP_NEAR, CLIP_FAR);
  camera.position.set(0, 3, 9);
  camera.lookAt(0, 3, 0);

  document.addEventListener('keypress', (event) => {
    console.log(event.code);
    if (event.code === 'Space') {
      running = !running;
    }
  });

  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  new OrbitControls(camera, renderer.domElement);

  const debugElement = document.createElement('div');
  debugElement.id = "debug";
  container.appendChild(debugElement);

  const sun = new THREE.DirectionalLight('#fff2dc', 2.5);
  sun.position.set(6, 11, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 2;
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 34;
  sc.left = -12; sc.right = 12; sc.top = 12; sc.bottom = -12;
  scene.add(sun);

  const worldRenderer = createWorldRenderer(b3, world);
  scene.add(worldRenderer.object3d);

  const human = createHuman(
    b3,
    world,
    [0, 0, 0],
    1,
    0.05,
  );
  worldRenderer.update();

  const debugInfo = ({ dt }: { dt: number }) => `FPS: ${Math.round(1000 / dt)}`;

  let lastTime = 0;
  const animate = (time: number) => {
    const dt = time - lastTime;
    lastTime = time;

    if (running) {
      b3.b3World_Step(world, 1 / 60, 4);
      worldRenderer.update();
    }
    renderer.render(scene, camera);
    debugElement.innerText = debugInfo({ dt });
  }
  renderer.setAnimationLoop(animate);
}
