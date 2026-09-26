import "./style.css";
import { Game } from "./game";
import Box3D from 'box3d.js';

await Game({
  b3: await Box3D(),
  container: document.body,
});
