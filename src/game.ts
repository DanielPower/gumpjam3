import * as THREE from "three";

const FIELD_OF_VIEW = 75;
const CLIP_NEAR = 0.1;
const CLIP_FAR = 1000;

export const Game = ({ container }: { container: HTMLElement }) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, window.innerWidth / window.innerHeight, CLIP_NEAR, CLIP_FAR);
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const debugElement = document.createElement('div');
  debugElement.id = "debug";
  container.appendChild(debugElement);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);

  const sunLight = new THREE.DirectionalLight(0xFFFFFF, 1);
  sunLight.position.set(5, 10, 0);
  sunLight.target.position.set(-5, 0, 0);
  scene.add(sunLight);

  const ambientLight = new THREE.AmbientLight(0xFFFFFF, 0.5);
  scene.add(ambientLight);

  camera.position.z = 5;

  const debugInfo = ({ dt }: { dt: number }) => `FPS: ${Math.round(1000 / dt)}`;

  let lastTime = 0;
  const animate = (time: number) => {
    const dt = time - lastTime;
    lastTime = time;

    cube.rotation.x = time / 2000;
    cube.rotation.y = time / 1000;
    renderer.render(scene, camera);
    debugElement.innerText = debugInfo({ dt });
  }
  renderer.setAnimationLoop(animate);
}
