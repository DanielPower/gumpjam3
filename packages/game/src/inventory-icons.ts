import type { PlacementKind } from "@stairs/shared/simulation";

/**
 * Hotbar icons for each placeable item, as inline SVG on a 48×48 grid. They're
 * drawn in the items' in-game colours, from roughly the edit camera's angle,
 * with a dark outline so they read on the slots' background.
 */
const OUTLINE = `stroke="#1b1b1b" stroke-width="2" stroke-linejoin="round"`;

const force = `
  <defs>
    <linearGradient id="force-strength" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#ffe14d"/>
      <stop offset="1" stop-color="#f2402c"/>
    </linearGradient>
  </defs>
  <path d="M7.5 35 L25 17.5 L20 12.5 L40 8 L35.5 28 L30.5 23 L13 40.5 Z" fill="url(#force-strength)" ${OUTLINE}/>
  <circle cx="10" cy="38" r="4" fill="#fff" ${OUTLINE}/>`;

const box = `
  <path d="M24 6 L41 14.5 L24 23 L7 14.5 Z" fill="#d49a5f" ${OUTLINE}/>
  <path d="M7 14.5 L24 23 L24 42 L7 33.5 Z" fill="#b07a45" ${OUTLINE}/>
  <path d="M41 14.5 L24 23 L24 42 L41 33.5 Z" fill="#8a5c31" ${OUTLINE}/>
  <path d="M7 24 L24 32.5 L41 24 M15.5 10.25 L32.5 18.75 M32.5 10.25 L15.5 18.75" fill="none" stroke="#5e3d1f" stroke-width="1.5" opacity="0.7"/>`;

const mine = `
  <defs>
    <radialGradient id="mine-glow">
      <stop offset="0" stop-color="#ff5030" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#ff5030" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <path d="M5 26 L5 31 A19 8 0 0 0 43 31 L43 26 Z" fill="#2a2e33" ${OUTLINE}/>
  <ellipse cx="24" cy="26" rx="19" ry="8" fill="#4a5058" ${OUTLINE}/>
  <ellipse cx="24" cy="26" rx="11" ry="4.5" fill="none" stroke="#2f3439" stroke-width="1.5"/>
  <circle cx="24" cy="22" r="10" fill="url(#mine-glow)"/>
  <ellipse cx="24" cy="23" rx="4" ry="3.2" fill="#ff3020" ${OUTLINE}/>
  <ellipse cx="22.8" cy="22" rx="1.4" ry="1" fill="#ffc0b0"/>`;

const bait = `
  <path d="M6 30 L38 17 L42 21 L42 34 L10 40 L6 37 Z" fill="#d99a1e" ${OUTLINE}/>
  <path d="M6 30 L38 17 L42 21 L10 34 Z" fill="#ffd95a" ${OUTLINE}/>
  <path d="M10 34 L42 21 L42 34 L10 40 Z" fill="#f2bd32" ${OUTLINE}/>
  <ellipse cx="22" cy="36" rx="2.6" ry="1.9" fill="#b97818"/>
  <ellipse cx="33" cy="29.5" rx="1.9" ry="2.3" fill="#b97818"/>
  <ellipse cx="18" cy="29" rx="2.4" ry="1.1" fill="#d99a1e"/>
  <ellipse cx="29" cy="24.5" rx="1.6" ry="0.8" fill="#d99a1e"/>`;

const rope = `
  <path d="M24 13 C35 13 41 17 41 22 C41 27 35 31 24 31 C13 31 7 27 7 22 C7 17 13 13 24 13 Z" fill="none" stroke="#1b1b1b" stroke-width="7"/>
  <path d="M24 13 C35 13 41 17 41 22 C41 27 35 31 24 31 C13 31 7 27 7 22 C7 17 13 13 24 13 Z" fill="none" stroke="#c89a5a" stroke-width="4"/>
  <path d="M24 18 C31 18 35 20 35 22.5 C35 25 31 27 24 27 C17 27 13 25 13 22.5 C13 20 17 18 24 18 Z" fill="none" stroke="#1b1b1b" stroke-width="7"/>
  <path d="M24 18 C31 18 35 20 35 22.5 C35 25 31 27 24 27 C17 27 13 25 13 22.5 C13 20 17 18 24 18 Z" fill="none" stroke="#a87a40" stroke-width="4"/>
  <path d="M38 27 C40 33 35 37 30 39 C26 40.5 22 40 19 42" fill="none" stroke="#1b1b1b" stroke-width="7" stroke-linecap="round"/>
  <path d="M38 27 C40 33 35 37 30 39 C26 40.5 22 40 19 42" fill="none" stroke="#c89a5a" stroke-width="4" stroke-linecap="round"/>
  <path d="M10 20 L38 24 M12 26 L36 20" fill="none" stroke="#7a5428" stroke-width="1" opacity="0.6"/>`;

const thruster = `
  <path d="M30 6 L40 16 L22 34 L14 26 Z" fill="#d8dde3" ${OUTLINE}/>
  <path d="M30 6 L40 16 L37 19 L27 9 Z" fill="#e0452d" ${OUTLINE}/>
  <path d="M22 34 L14 26 L11 29 L19 37 Z" fill="#3a3d42" ${OUTLINE}/>
  <path d="M13 31 C7 33 5 38 4 44 C10 43 15 41 17 35 Z" fill="#ffa040" ${OUTLINE}/>
  <path d="M13.5 33.5 C10 35 9 38 8.5 40 C11 39.5 13 38 14.5 35.5 Z" fill="#fff3c0"/>`;

const ICONS: Record<PlacementKind, string> = { force, box, mine, bait, rope, thruster };

export function inventoryIcon(kind: PlacementKind) {
  const template = document.createElement("template");
  template.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">${ICONS[kind]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}
