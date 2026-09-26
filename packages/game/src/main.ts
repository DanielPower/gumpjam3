import "@fontsource-variable/inter/wght.css";
import "@fontsource/lilita-one";
import "./style.css";
import { Game, levelFromUrl, type GameHandle } from "./game";
import Box3D from "box3d.js";

const b3 = await Box3D();

// Switching levels swaps one game for the next in place, without reloading the
// page. The URL follows along, so the back button and links still work.
let game: GameHandle | null = null;
const play = (levelId: string) => {
  game?.dispose();
  game = Game({ b3, container: document.body, levelId, onSelectLevel });
};
const onSelectLevel = (levelId: string) => {
  const url = new URL(window.location.href);
  url.searchParams.set("level", levelId);
  history.pushState(null, "", url);
  play(levelId);
};
window.addEventListener("popstate", () => play(levelFromUrl()));
play(levelFromUrl());
