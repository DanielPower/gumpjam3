"""Generates the "Rat Race" level:
    python3 packages/shared/scripts/rat_race.py packages/shared/levels/level4.map

A maintenance stair descends into a rat kingdom. Player-placed cheese bait
draws two clockwork rats out of their tunnels on visible charge paths, letting
the player arrange deliberate high-speed collisions in the open arena.
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from mapgen import *  # noqa: E402,F403

m = MapWriter()
entity = m.entity


def world_face(normal, point, texture):
    """A face specified in world axes rather than map axes."""
    nx, ny, nz = normal
    return face((nx, -nz, ny), tb(*point), texture)


def xy_prism(vertices, z0, z1, texture):
    """Extrude a counter-clockwise polygon in world XY along world Z."""
    faces = []
    for i, (x0, y0) in enumerate(vertices):
        x1, y1 = vertices[(i + 1) % len(vertices)]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        faces.append(world_face((dy / length, -dx / length, 0), (x0, y0, z0), texture))
    faces.append(world_face((0, 0, -1), (vertices[0][0], vertices[0][1], z0), texture))
    faces.append(world_face((0, 0, 1), (vertices[0][0], vertices[0][1], z1), texture))
    return faces


def wheel_bar(cx, cy, length, width, angle, z0, z1, texture):
    """A rectangular bar in XY, rotated around (cx, cy), extruded along Z."""
    c, s = math.cos(angle), math.sin(angle)
    points = []
    for along, across in ((-length/2, -width/2), (length/2, -width/2),
                          (length/2, width/2), (-length/2, width/2)):
        points.append((cx + along*c - across*s, cy + along*s + across*c))
    return xy_prism(points, z0, z1, texture)


def ramp(x0, x1, low, high, z0, z1, texture, top_texture):
    """A solid whose top rises from low at x0 to high at x1."""
    faces = box(x0, x1, -1.2, high, z0, z1, texture)
    rise, run = high - low, x1 - x0
    normal = norm((-rise, 0, run))
    faces[4] = face((normal[0], 0, normal[2]), tb(x1, high, z0), top_texture)
    return faces


def rat(cx, floor, cz, facing, coat="fur"):
    """A chunky brushwork rat, facing along world Z."""
    s = 1 if facing > 0 else -1
    brushes = [
        box(cx - 0.52, cx + 0.52, floor + 0.18, floor + 0.9, cz - 0.8, cz + 0.8, coat),
        box(cx - 0.42, cx + 0.42, floor + 0.28, floor + 0.82,
            cz + s*0.7 - (0.05 if s > 0 else 0.55), cz + s*0.7 + (0.55 if s > 0 else 0.05), coat),
        box(cx - 0.22, cx + 0.22, floor + 0.34, floor + 0.62,
            cz + s*1.18 - 0.22, cz + s*1.18 + 0.22, "pink"),
    ]
    # Ears and feet protrude enough to read clearly and to make impacts lumpy.
    for x in (cx - 0.38, cx + 0.22):
        brushes.append(box(x, x + 0.18, floor + 0.78, floor + 1.12,
                           cz + s*0.55 - 0.12, cz + s*0.55 + 0.12, "pink"))
    for x in (cx - 0.55, cx + 0.35):
        brushes.append(box(x, x + 0.2, floor, floor + 0.28, cz - 0.48, cz + 0.48, "pink"))
    # A segmented tail trails behind.
    for i in range(4):
        z = cz - s*(0.9 + i*0.38)
        brushes.append(box(cx - 0.10, cx + 0.10, floor + 0.24 + i*0.08,
                           floor + 0.38 + i*0.08, z - 0.27, z + 0.27, "pink"))
    return brushes


# --- The sewer chamber and maintenance stair --------------------------------
world = []
FLOOR = 0
world.append(box(-17, 3.2, -1.2, FLOOR, -7, 7, "stone_dark", top="slime"))
# Open-backed start platform and its railings.
world.append(box(11.8, 16, -1.2, 8, -3.2, 3.2, "brick", top="concrete"))
for z in (-3.15, 3.0):
    world.append(box(11.8, 16, 8, 9.0, z, z + 0.15, "rust"))

# Fourteen short, punishing maintenance steps.
STEP_RUN, STEP_DROP = 0.62, 0.5
for i in range(14):
    x1 = 11.8 - STEP_RUN*i
    top = 8 - STEP_DROP*(i + 1)
    world.append(box(x1 - STEP_RUN, x1, -1.2, top, -2.1, 2.1, "brick", top="metal"))

# Far wall, low camera-side curb, drainage channel, and wall pipes.
world.append(box(-17, 16, -1.2, 10, -7.3, -7, "brick"))
world.append(box(-17, 3.2, 0, 0.45, 6.7, 7, "stone_dark", top="slime"))
# Leave a gap beneath the spring wedge at the end, avoiding intersecting static
# brushes and making the wedge's landing surface unambiguous.
world.append(box(-17, -16.2, -0.18, 0.03, -1.0, 1.0, "water", top="water"))
world.append(box(-13.8, 3.2, -0.18, 0.03, -1.0, 1.0, "water", top="water"))
for y in (2.0, 5.2):
    world.append(box(-16, 15.5, y, y + 0.34, -6.96, -6.65, "rust"))
for x in (-14, -8, -2, 4, 10):
    world.append(box(x - 0.2, x + 0.2, 0, 9.5, -6.92, -6.55, "stone"))

# Rat holes and cheese offerings in the far wall.
for x in (-11.5, -5.5, 0.0):
    world.append(box(x - 1.0, x + 1.0, 0.35, 1.85, -6.98, -6.91, "dark"))
    world.append(box(x - 0.65, x + 0.65, 0.18, 0.38, -6.9, -6.5, "cheese"))

entity({
    "classname": "worldspawn", "message": "Rat Race", "sky": "#15272b", "sun": "80 120 300",
    "inventory_force": "2", "inventory_box": "2", "inventory_mine": "2", "inventory_bait": "2",
    "inventory_rope": "2", "inventory_thruster": "2",
    "run_quiet_seconds": "4",
}, world)


# --- The old rat wheel -------------------------------------------------------
# Keep the level's visual landmark mounted harmlessly on the back wall. It no
# longer spins, blocks the stair landing, or traps the ragdoll in repeated hits.
WHEEL_X, WHEEL_Y = 7.6, 4.2
wheel = []
for i in range(12):
    angle = i * math.pi / 6
    wheel.append(wheel_bar(WHEEL_X + 1.35*math.cos(angle), WHEEL_Y + 1.35*math.sin(angle),
                           0.48, 0.14, angle + math.pi/2, -6.48, -6.24, "wood"))
for angle in (0, math.pi/3, 2*math.pi/3):
    wheel.append(wheel_bar(WHEEL_X, WHEEL_Y, 2.75, 0.15, angle, -6.46, -6.26, "rust"))
wheel.append(box(WHEEL_X - 0.16, WHEEL_X + 0.16, WHEEL_Y - 0.16, WHEEL_Y + 0.16,
                 -6.53, -6.19, "metal"))
entity({"classname": "func_group"}, wheel)


# --- Clockwork rat traffic --------------------------------------------------
# Each bait claims one rat. They begin behind the far wall, turn toward their
# assigned cheese during setup, then make one readable pass once the ragdoll
# approaches their bait. The short delays only prevent an immediate launch.
for i, (x, speed, delay) in enumerate(((-4.2, 11.0, 0.3), (-8.2, 9.5, 0.65))):
    start_z = -12
    entity({"classname": "func_rat", "origin": origin(x, FLOOR, start_z),
            "speed": fmt(speed * U), "delay": str(delay), "forward": "0 -32 0"},
           rat(x, FLOOR, start_z, 1, "fur_dark" if i else "fur"))

# Tunnel housings conceal the rats' loop jump and make the crossing readable.
for x in (-4.2, -8.2):
    for z0, z1 in ((-12.8, -6.9), (6.9, 12.8)):
        world_bits = [
            box(x - 1.25, x + 1.25, 0, 2.2, z0, z1, "stone_dark"),
            box(x - 1.5, x + 1.5, 2.2, 2.55, z0, z1, "rust"),
        ]
        entity({"classname": "func_group"}, world_bits)


# --- The Rat King's dais and tail sweeper -----------------------------------
# The tail circles the final arena; surviving the rat traffic can still feed a
# body back through it for another run of impacts.
tail = [
    box(-13.2, -9.0, 0.35, 0.58, -0.16, 0.16, "pink"),
    box(-13.2, -12.8, 0.25, 0.72, -0.28, 0.28, "pink"),
]
tx, ty, tz = tb(-13.0, 0.45, 0)
entity({"classname": "func_rotating", "origin": f"{fmt(tx)} {fmt(ty)} {fmt(tz)}", "speed": "145"}, tail)

# Throne/statue outside the main travel line.
statue = rat(-14.0, FLOOR, -4.3, 1, "fur_king")
statue.extend([
    box(-14.7, -13.3, 1.0, 1.25, -4.7, -3.9, "gold"),
    box(-14.55, -14.25, 1.2, 1.75, -4.65, -4.45, "gold"),
    box(-13.75, -13.45, 1.2, 1.75, -4.65, -4.45, "gold"),
])
entity({"classname": "func_group"}, statue)

# A springy wedge at the dead end can return the ragdoll toward the moving rats.
entity({"classname": "func_bouncy", "restitution": "1.65", "friction": "0.25"},
       [ramp(-16.2, -13.8, 0.0, 1.35, -2.4, 2.4, "cheese", "cheese")])


# Start on the platform facing down the stairs. The camera sees the open arena,
# bait routes, and rat tunnels from the chamber's open side.
entity({"classname": "info_player_start", "origin": origin(12.15, 8.03, 0), "angle": "180"})
entity({"classname": "info_edit_camera", "origin": origin(0.0, 3.2, 0.2), "angle": "28", "view": "23"})

m.write(sys.argv[1])
