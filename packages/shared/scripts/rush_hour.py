"""Generates the "Rush Hour" level (packages/shared/levels/level2.map):
    python3 packages/shared/scripts/rush_hour.py packages/shared/levels/level2.map
Regenerating overwrites edits made in TrenchBroom.  Coordinates are
world metres: x along the level, y up, z sideways. TrenchBroom is Z-up in
32 units per metre: TB (X, Y, Z) = (x, -z, y) * 32."""
import math, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from mapgen import *  # noqa: E402,F403

m = MapWriter()
entity = m.entity

# --- worldspawn -------------------------------------------------------------
world = []
G = -2.5    # bottom of all ground slabs
# How far the street runs each way (+z, -z). The -z end is longer, as the bus
# starts deep in its tunnel.
STREET_END, STREET_START = 31, -51
R = -1.5    # street surface, 1.5 m below the pavement
EDGE = -3.9  # where the pavement drops to the street, just past the stair foot
FAR = EDGE - 10  # far side of the street
MID = (EDGE + FAR) / 2  # centre line
NEAR_LANE, FAR_LANE = (EDGE + MID) / 2, (MID + FAR) / 2
# Pavement around the stairs, grass beyond.
world.append(box(EDGE, 12, G, 0, -9, 9, "concrete", top="pavement"))
world.append(box(EDGE, 12, G, 0, 9, 31, "concrete", top="grass"))
world.append(box(EDGE, 12, G, 0, STREET_START, -9, "concrete", top="grass"))
# Rooftop building the ragdoll starts on, with a parapet.
world.append(box(2, 9, 0, 5, -3.5, 3.5, "brick", top="concrete"))
world.append(box(8.6, 9, 5, 5.9, -3.5, 3.5, "concrete"))
world.append(box(2, 8.6, 5, 5.9, 3.1, 3.5, "concrete"))
world.append(box(2, 8.6, 5, 5.9, -3.5, -3.1, "concrete"))
# Stairs straight down towards the street: nine 0.5 m steps, 0.6 m deep.
for i in range(9):
    top = 5 - 0.5 * (i + 1)
    world.append(box(2 - 0.6 * (i + 1), 2 - 0.6 * i, 0, top, -2, 2, "concrete"))
# Lamp posts and benches along the pavement edge, clear of the stairs.
for z in (-7.5, 7.5):
    world.append(box(EDGE + 0.25, EDGE + 0.45, 0, 4, z - 0.1, z + 0.1, "metal"))
    world.append(box(EDGE, EDGE + 0.7, 4, 4.2, z - 0.25, z + 0.25, "yellow"))
    world.append(box(-2.5, 0.5, 0, 0.45, z + (1.3 if z > 0 else -1.3) - 0.3, z + (1.3 if z > 0 else -1.3) + 0.3, "wood"))
# The street, running into tunnels at both ends.
world.append(box(FAR - 2, EDGE, G, R, STREET_START, STREET_END, "concrete", top="asphalt"))
for k in range(-9, 10):  # dashed centre line
    z = k * 2.0
    world.append(box(MID - 0.08, MID + 0.08, R, R + 0.01, z - 0.5, z + 0.5, "stripe_yellow"))
world.append(box(EDGE - 0.5, EDGE - 0.35, R, R + 0.01, -18, 18, "stripe_white"))
world.append(box(FAR + 0.35, FAR + 0.5, R, R + 0.01, -18, 18, "stripe_white"))
# Far pavement and the shops across the street.
world.append(box(FAR - 2, FAR, R, R + 0.15, -18, 18, "concrete", top="pavement"))
# Single-storey shopfronts, low enough not to hide the street from the edit camera.
world.append(box(FAR - 8, FAR - 2, G, R + 2.5, -18, 18, "brick", top="concrete"))
for z in range(-15, 16, 5):
    world.append(box(FAR - 2, FAR - 1.97, R + 0.5, R + 2.1, z - 1.6, z + 1.6, "glass"))  # on the shopfront, not in it
world.append(box(FAR - 2, FAR - 1.75, R + 2.2, R + 2.6, -18, 18, "red"))  # trim along the roofline
# Tunnels at both ends of the street, where the vehicles start and end out of sight.
for s in (1, -1):
    z0, z1 = (18, STREET_END) if s > 0 else (STREET_START, -18)
    world.append(box(FAR - 8, FAR, R, 5, z0, z1, "concrete"))
    world.append(box(EDGE, EDGE + 2, 0, 5, z0, z1, "concrete"))
    world.append(box(FAR, EDGE, 3, 5, z0, z1, "concrete", bottom="dark"))
    back = (STREET_END - 1, STREET_END) if s > 0 else (STREET_START, STREET_START + 1)
    world.append(box(FAR, EDGE, R, 3, back[0], back[1], "dark"))
    mouth = 18 if s > 0 else -18
    lz0, lz1 = sorted((mouth, mouth - 0.3 * s))
    world.append(box(FAR - 0.2, EDGE + 0.2, 3, 3.5, lz0, lz1, "yellow"))

entity({"classname": "worldspawn", "message": "Rush Hour", "inventory_force": "3", "inventory_box": "2",
        "sky": "#9ecbf2"}, world)

# --- merry-go-round, beside the stairs ---------------------------------------
# Spinning anticlockwise from above: whatever lands on its stair-side edge is
# carried round and flung out towards the street.
cx, cz = -0.6, 4.55
mgr = [prism(cx, cz, 2.4, 0.02, 0.14, 16, "red", top="yellow")]
mgr.append(prism(cx, cz, 0.15, 0.14, 2.3, 8, "metal"))
mgr.append(prism(cx, cz, 0.9, 2.3, 2.45, 12, "blue"))
for dx, dz in ((1.9, 0), (-1.9, 0), (0, 1.9), (0, -1.9)):
    mgr.append(box(cx + dx - 0.06, cx + dx + 0.06, 0.14, 1.4, cz + dz - 0.06, cz + dz + 0.06, "metal"))
mgr.append(box(cx - 1.96, cx + 1.96, 1.25, 1.35, cz - 0.05, cz + 0.05, "metal"))
mgr.append(box(cx - 0.05, cx + 0.05, 1.25, 1.35, cz - 1.96, cz + 1.96, "metal"))
ox, oy, oz = tb(cx, 0, cz)
entity({"classname": "func_rotating", "speed": "220", "origin": f"{fmt(ox)} {fmt(oy)} {fmt(oz)}"}, mgr)

# --- a trampoline on the other side, tilted towards the street ------------------
def tilted_pad(x0, x1, z0, z1, low, high):
    """Box whose top slopes down towards -x: `high` at x1, `low` at x0."""
    faces = box(x0, x1, 0, high, z0, z1, "blue")
    rise, run = high - low, x1 - x0
    n = norm((-rise, 0, run))  # world (x, y) normal of the slope, pointing up and towards -x
    faces[4] = face((n[0], 0, n[2]), tb(x1, high, z0), "trampoline")
    return faces
entity({"classname": "func_bouncy", "restitution": "2", "friction": "0.3"},
       [tilted_pad(-2.0, 0.6, -4.4, -2.15, 0.2, 1.9)])

# --- vehicles ---------------------------------------------------------------------
def car(x, z, colour):
    parts = [box(x - 0.95, x + 0.95, R + 0.25, R + 0.95, z - 2.2, z + 2.2, colour)]
    parts.append(box(x - 0.85, x + 0.85, R + 0.95, R + 1.55, z - 1.2, z + 1.0, "glass", top=colour))
    for wx in (x - 1.0, x + 0.7):  # tyres stand 5 cm proud of the body, so they don't z-fight
        for wz in (z - 1.4, z + 1.4):
            parts.append(box(wx, wx + 0.3, R, R + 0.6, wz - 0.32, wz + 0.32, "rubber"))
    return parts

def bus(x, z, colour):
    parts = [box(x - 1.25, x + 1.25, R + 0.35, R + 3.1, z - 4.6, z + 4.6, colour, top="white")]
    parts.append(box(x - 1.3, x + 1.3, R + 1.6, R + 2.5, z - 4.2, z + 3.6, "glass", top=colour))
    for wx in (x - 1.3, x + 1.0):
        for wz in (z - 3.0, z + 3.0):
            parts.append(box(wx, wx + 0.3, R, R + 0.8, wz - 0.42, wz + 0.42, "rubber"))
    return parts

# A car in the near lane heading -z, fast; it starts just inside its tunnel and
# drives down the street once, passing the stairs about 1.6 s in.
entity({"classname": "func_car", "move": f"0 {fmt(49.5 * U)} 0", "speed": fmt(14 * U),
        "mass": "1200"}, car(NEAR_LANE, 22, "red"))
# A bus in the far lane heading +z, slower, from deep in its tunnel: it passes
# the stairs about 4.4 s in.
entity({"classname": "func_car", "move": f"0 {fmt(-67 * U)} 0", "speed": fmt(9 * U),
        "mass": "8000"}, bus(FAR_LANE, -40, "yellow"))

# --- player start -----------------------------------------------------------------
px, py, pz = tb(2.35, 5, 0)
entity({"classname": "info_player_start", "origin": f"{fmt(px)} {fmt(py)} {fmt(pz + 1)}", "angle": "180"})

# Where the edit camera starts: between the stairs and the street, looking back
# at the building from the street side.
fx, fy, fz = tb(-4.5, 0, 0.5)
entity({"classname": "info_edit_camera", "origin": f"{fmt(fx)} {fmt(fy)} {fmt(fz)}", "angle": "20", "view": "19"})

m.write(sys.argv[1])
