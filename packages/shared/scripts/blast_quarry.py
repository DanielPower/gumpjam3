"""Generates the "Blast Quarry" level (packages/shared/levels/level3.map):
    python3 packages/shared/scripts/blast_quarry.py packages/shared/levels/level3.map
Regenerating overwrites edits made in TrenchBroom.

An open quarry cut into giant terraces, full of explosive barrels. The player
gets one force, one box and three mines: start the tumble, then chain blasts to
keep the ragdoll flying round the pit. The walls keep it all in play."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from mapgen import *  # noqa: E402,F403

m = MapWriter()

TOP = 9.0          # the ledge the ragdoll starts on
DROP, RUN = 1.5, 2.5
EDGE = 14.0        # x where the top ledge ends and the first drop begins
W = 7.0            # half-width of the quarry
WALL = 13.0        # quarry wall height
FLOOR_END = -14.0  # far end of the pit floor

world = []
# Top ledge, where the ragdoll starts, running back to the quarry's back wall.
world.append(box(EDGE, 22, -2, TOP, -W, W, "sandstone_dark", top="gravel"))
# Five terraces, each a 1.5 m drop and 2.5 m deep, down to the pit floor.
for i in range(5):
    x1 = EDGE - RUN * i
    top = TOP - DROP * (i + 1)
    world.append(box(x1 - RUN, x1, -2, top, -W, W, "sandstone_dark", top="sandstone"))
PIT = TOP - DROP * 6  # 0.0
world.append(box(FLOOR_END, EDGE - RUN * 5, -2, PIT, -W, W, "sandstone_dark", top="gravel"))
# The quarry face: a tall rock wall along the far side, and a low one behind
# the start. The pit end and near side open onto surrounding ground at pit
# level, so the edit camera can see in and blasted ragdolls stay in play.
world.append(box(FLOOR_END - 16, 25, -2, WALL, -W - 3, -W, "sandstone_dark", top="grass"))
world.append(box(22, 25, -2, TOP + 1.5, -W, W, "sandstone_dark", top="grass"))
world.append(box(FLOOR_END - 16, 25, -2, PIT, W, W + 18, "sandstone_dark", top="grass"))      # ground beside the quarry
world.append(box(FLOOR_END - 16, FLOOR_END, -2, PIT, -W, W, "sandstone_dark", top="gravel"))  # ground past the pit
# Kerbs along the open side of each terrace.
for i in range(-1, 5):
    x1 = EDGE - RUN * i if i >= 0 else 22
    x0 = EDGE - RUN * (i + 1) if i >= 0 else EDGE
    top = TOP - DROP * (i + 1) if i >= 0 else TOP
    world.append(box(x0, x1, top, top + 0.35, W - 0.35, W, "concrete"))
# A low fence around the outside of the site.
for x0, x1, z0, z1 in ((FLOOR_END - 16, 25, W + 17.8, W + 18), (FLOOR_END - 16, FLOOR_END - 15.8, -W, W + 18)):
    world.append(box(x0, x1, PIT, PIT + 1.1, z0, z1, "metal"))
# Rock piles and boulders around the pit edges (hulls with sloped sides).
def pile(cx, cz, r, h, base):
    return prism(cx, cz, r, base, base + h, 6, "rock", top="rock")
world.append(pile(-11.5, 5.2, 1.6, 1.2, PIT))
world.append(pile(-12.2, 3.3, 1.0, 0.7, PIT))
world.append(pile(-2.0, -5.6, 1.2, 0.8, PIT))
world.append(pile(8.0, 5.8, 0.9, 0.6, TOP - DROP * 3))
# A parked dump truck on the pit floor: chassis, bed, cab, wheels.
tx, tz = -7.5, 4.3
world.append(box(tx - 2.6, tx + 2.0, PIT + 0.5, PIT + 1.1, tz - 1.1, tz + 1.1, "yellow"))
world.append(box(tx - 2.6, tx + 0.4, PIT + 1.1, PIT + 2.2, tz - 1.2, tz + 1.2, "yellow", top="rust"))
world.append(box(tx + 0.6, tx + 2.0, PIT + 1.1, PIT + 2.5, tz - 1.0, tz + 1.0, "yellow"))
world.append(box(tx + 1.95, tx + 2.0, PIT + 1.7, PIT + 2.3, tz - 0.85, tz + 0.85, "glass"))
for wx in (tx - 1.8, tx + 1.3):
    for wz in (tz - 1.25, tz + 0.95):
        world.append(box(wx - 0.5, wx + 0.5, PIT, PIT + 1.0, wz, wz + 0.3, "rubber"))
# Site cabin on the top ledge, behind the ragdoll.
world.append(box(18.5, 21.5, TOP, TOP + 2.6, -6.5, -2.5, "orange", top="metal"))
world.append(box(18.45, 18.5, TOP + 1.0, TOP + 2.0, -5.8, -4.2, "glass"))
# Floodlight masts on the top ledge corners.
for z in (-6.2, 6.2):
    world.append(box(20.6, 20.9, TOP, TOP + 6, z - 0.15, z + 0.15, "metal"))
    world.append(box(20.0, 20.7, TOP + 5.6, TOP + 6.4, z - 0.6, z + 0.6, "lantern"))
# Hazard stripes along the top ledge's edge (flush with the surface).
for k in range(-6, 7, 2):
    world.append(box(EDGE, EDGE + 0.3, TOP, TOP + 0.01, k - 0.5, k + 0.5, "yellow"))

m.entity({"classname": "worldspawn", "message": "Blast Quarry", "sky": "#bcd9ea", "sun": "64 -24 384",
          "inventory_force": "1", "inventory_box": "1", "inventory_mine": "3"}, world)

# Explosive barrels: on the terraces, and in fuel depots on the pit floor.
barrels = [
    (EDGE - RUN * 1 - 1.2, TOP - DROP * 2, z) for z in (-0.7, 0.0, 0.7)   # third ledge down
] + [
    (EDGE - RUN * 3 - 1.0, TOP - DROP * 4, z) for z in (-2.5, 2.5)          # fifth ledge down
] + [
    (x, PIT, z) for x, z in ((-2.5, -1.0), (-2.5, 1.0), (-3.3, 0.0))      # a cluster at the foot of the terraces
] + [
    (x, PIT, z) for x, z in ((-11.0, -4.5), (-11.0, -3.7), (-11.8, -4.1), (-10.2, -4.1))  # the fuel depot
]
for x, y, z in barrels:
    m.entity({"classname": "prop_barrel", "origin": origin(x, y, z)})

# The ragdoll starts at the top edge, facing down into the quarry.
m.entity({"classname": "info_player_start", "origin": origin(EDGE + 0.4, TOP + 0.03, 0), "angle": "180"})
# Look up the terraces from the pit's open corner, so the drops face the camera.
m.entity({"classname": "info_edit_camera", "origin": origin(5, 5, 0), "angle": "40", "view": "23"})

m.write(sys.argv[1])
