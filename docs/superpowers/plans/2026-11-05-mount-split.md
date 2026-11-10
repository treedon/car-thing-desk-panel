# Mount in Three Prints: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** split the one-piece main mount into a plate, a rod and a dock, glued at two keyed joints. Each part prints in its own orientation, with no support taller than 3 mm.

**Architecture:**
- **Joints:** a new `lib/joint.scad` holds the joint geometry: the plate's socket, the rod's D-shaped top, and the flange and spigot that meet the dock.
- **Parts:** `main-mount.scad` keeps one part switch that renders each part in its print orientation (`plate`, `rod`, `dock`), plus test renders (`leak`, `clash`, `collide`, `channel`).
- **Support check:** a pure-Python `test/supports.py` checks each exported STL against the owner's support rule.

**Tech stack:** OpenSCAD (snapshot, run with `--hardwarnings --backend=Manifold`), bash, awk, Python 3.9 standard library only, FreeCAD for STEP.

**Spec:** [docs/superpowers/specs/2026-11-05-mount-split-design.md](../specs/2026-11-05-mount-split-design.md), which builds on [2026-11-04-mount-redesign-design.md](../specs/2026-11-04-mount-redesign-design.md).

All paths below are relative to `hardware/mount/` unless they start with `docs/`.

## Global Constraints

**Unchanged:**
- From the seat, the mount looks as it does today.
- The rod stays `rod_d = 22` on the same path: straight down, one bend, straight forward, centred on the Car Thing.
- The Car Thing's position doesn't change.

**Code rules:**
- Every dimension lives in `params.scad`. A guess is marked `MEASURE`.
- Every printed part goes through `as_owner()` (mirrored in x).
- No Python package outside the standard library; numpy isn't installed.

**Supports:**
- No print may need a build-plate support taller than **3 mm**.
- A bridge over a hole up to **15 mm** across is allowed.
- Any other bridge must be anchored on two opposite sides within **35 mm**.
- A surface counts as an overhang when it's flatter than 45°, which is a unit normal z below **−0.72**.

**Joints:**
- **Socket:** at least `rod_d` (22 mm) deep, with a D flat toward the monitor.
- **Flange:** 36–40 mm across, at least `rod_d_hidden + 12`, sitting flat on the dock's back with a glue gap of `fit / 2`.
- **Spigot:** about 14 mm teardrop, about 6 mm long, point down.

**Must keep passing:**
- the 5 N button-press sag of 0.1 mm or less (`lib/stiffness.scad`), unchanged;
- every existing rule in `checks.scad`, the leak test, the clash test and the visibility checks.

**Every commit ends with:**
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

Each of these failure modes gets its own test, in the task that owns the code:

1. **Parts that overlap or keys that don't line up** when assembled. The parts must not intersect anywhere. (Task 2, `collide`.)
2. **A part that forgets to clear the cord channel,** or a joint that blocks it. No material may sit inside the channel. (Task 2, `channel`.)
3. **Thin socket walls,** which make the most heavily loaded joint weak. At least 3 mm of base all round the bore. (Task 2, rule.)
4. **A print aid that shows from the seat.** The keel foot, the bend wedge and the flange rim must stay hidden. (Task 4, rule.)
5. **The spigot's point cut off** by the rod part's bed plane. It must stay at least 1 mm above it. (Task 4, rule.)

---

### Task 1: The support check

**Files:**
- Create: `test/supports.py`
- Create: `test/fixtures/supports.scad`
- Modify: `standalone-shelf.scad`, so the printable part is exported standing on its end
- Modify: `test/mount.test.sh`

**Interfaces:**
- **Produces:** `python3 -I test/supports.py [--max-support 3] [--hole 15] [--max-bridge 35] FILE.stl`
  - Reads ASCII or binary STL.
  - Prints one line: `supports: tallest support <a> mm, longest bridge <b> mm`.
  - Exits 0 if the part passes. Otherwise it exits 1 and lists up to 10 offending points as `support <h> mm at (x, y, z)` or `bridge <s> mm at (x, y, z)`.
- **Produces:** in `test/mount.test.sh`, `supports <label> <stl>`, which runs the script as a `check`.

- [ ] **Step 1: Write the test shapes.**
  - `test/fixtures/supports.scad` takes `shape` (`"slab"`, `"chamfer"`, `"hole"`, `"bridge"`) and `span` (default 30).
  - **`slab`:** a 5 × 5 × 30 mm post with a 40 × 40 × 3 mm slab on top.
  - **`chamfer`:** a 30 mm tall block whose overhanging side is exactly 45°.
  - **`hole`:** a 30 × 30 × 20 mm block with a 10 mm blind hole up from the bed, 10 mm deep.
  - **`bridge`:** a 3 mm base on the bed, two 20 mm walls `span` apart along x, and a 3 mm roof over both.

- [ ] **Step 2: Add the fixture checks to `test/mount.test.sh`.** These run before the parts.

```bash
fixture() { # label, expect (pass|fail), openscad -D args...
  local label=$1 want=$2; shift 2
  scad --export-format asciistl -o "$tmp/fx.stl" "$@" "$here/fixtures/supports.scad" >/dev/null 2>&1
  local got=fail; python3 -I "$here/supports.py" "$tmp/fx.stl" >/dev/null 2>&1 && got=pass
  check "support check: $label ${want}s" "[ $got = $want ]"
}
fixture "a slab on a post" fail -D 'shape="slab"'
fixture "a 45-degree chamfer" pass -D 'shape="chamfer"'
fixture "a 10 mm hole from the bed" pass -D 'shape="hole"'
fixture "a 30 mm bridge" pass -D 'shape="bridge"' -D span=30
fixture "a 50 mm bridge" fail -D 'shape="bridge"' -D span=50
```

- [ ] **Step 3: Run `./test/mount.test.sh`.**
  - Expected: the three `pass` fixtures FAIL, because `supports.py` doesn't exist yet and `got` stays `fail`.
  - The two `fail` fixtures show `ok` by accident at this point. That's expected.

- [ ] **Step 4: Write `test/supports.py`** with this rule.

```text
bed = lowest vertex z
for each triangle, unit normal n from its vertices (ignore the file's normals):
  skip unless n.z < -0.72 and the triangle isn't lying on the bed (all vertices within 0.01 of bed)
  samples = centroid, and the midpoints between the centroid and each vertex
  for each sample p, at q = p - (0, 0, 0.02):
    below = highest hit of a ray straight down from q, ignoring the triangle itself
    if no hit:                                    # it would need a build-plate support
      h = q.z - bed
      if h <= max_support: ok                     # small overhang at the bed
      elif rays from q along +x, -x, +y, -y all hit within `hole`: ok   # bridge over a small hole
      else: fail as "support h"
    else:                                         # bridge over the part
      span = min over the axes x, y of (hit distance in + direction + hit distance in - direction)
      fail as "bridge span" if span > max_bridge (a missing hit counts as infinite)
```

  - Index triangles in a 4 mm grid three ways, for the vertical rays (cells in x, y), the x rays (cells in y, z) and the y rays (cells in x, z). Without that, the plate takes too long.
  - "Tallest support" and "longest bridge" report the largest values found, whether allowed or not.

- [ ] **Step 5: Run `./test/mount.test.sh`.**
  - Expected: all five `support check:` lines `ok`.
  - Then time the check on today's `stl/main-mount.stl`, raised so its lowest point is at z = 0. It must fail, reporting a support of about 90 mm. Note how long it took. If it's over 20 s, tighten the grid.

- [ ] **Step 6: Export the standalone shelf in its print orientation.**
  - In `standalone-shelf.scad`, `part = "shelf"` renders the shelf standing on one end of its slot.
  - The extents become about 27 × 96.8 × 114.3 mm. The `clash` part stays as it is, in mounted coordinates.

- [ ] **Step 7: Run the check on the standalone shelf.**
  - In `test/mount.test.sh`, call `supports standalone-shelf "$tmp/part.stl"` from `part()` for that part.
  - Run `./test/mount.test.sh`. Expected: `ok   standalone-shelf prints without big supports`, and every other line `ok`.

- [ ] **Step 8: Commit.** `test(mount): a support check for every print`

---

### Task 2: Split into plate, rod and dock with keyed glue joints

**Files:**
- Create: `lib/joint.scad`
- Modify:
  - `params.scad`: joint parameters, and `pocket_z0` derived from them;
  - `lib/geometry.scad`: `ct_unplace()`;
  - `lib/rod.scad`;
  - `lib/dock.scad`;
  - `lib/pocket.scad`: the pocket's base runs down to z = 0;
  - `main-mount.scad`;
  - `checks.scad`;
  - `test/mount.test.sh`.

**Interfaces:**
- **Produces** these `params.scad` values, in a new "Joints" section placed before the pocket section:
  - `socket_depth = 24`
  - `socket_flat = 2`
  - `socket_cone = 50` (degrees from horizontal)
  - `flange_d = 38`
  - `flange_t = 4`
  - `spigot_d = 14`
  - `spigot_len = 6`
  - `keel_gap = 1`
- **Produces** `pocket_z0 = socket_depth + (rod_d + fit - cord_d - 1) / 2 * tan(socket_cone) + wall`, which is about 36.7.
- **Produces** in `lib/joint.scad`. Plate-side geometry is in mounted coordinates, and dock-side geometry is in the Car Thing's local frame.
  - `function socket_cone_h()`: the cone's height above `socket_depth`.
  - `module rod_top_end()`: the rod's D-shaped top, from z = 0 to `socket_depth`. The flat is on the +y side, `socket_flat` in from the circle.
  - `module socket_negative()`: the matching D bore, `fit` larger, from z = −1 to `socket_depth`. A D-shaped cone above it narrows at `socket_cone` to the cord channel's diameter (`cord_d + 1`).
  - `module flange_local()`: in the local frame. A disc of `flange_d` × `flange_t` and a teardrop spigot of `spigot_d` × `spigot_len`, pointing toward local −z. Both sit on the axis through `[ct_w / 2, *, -ct_h / 2]`, with the flange's face `fit / 2` behind the plane `y = -backplate_thickness()`.
  - `module spigot_hole_local()`: in the local frame. The teardrop, `fit` larger, from the dock's back to `spigot_len + 0.5` deep, with a flat top. That top is a bridge over a small hole, so it needs no cone.
  - `function flange_rim_pts()`: local points every 15° around the flange's rim, on both faces.
- **Produces** in `lib/geometry.scad`: `module ct_unplace()`, the inverse of `ct_place()`.
- **Produces** in `lib/rod.scad`:
  - `rod_z_top()` is renamed `cord_z_top() = pocket_z0 + 1`, the top of the cord channel inside the pocket.
  - `rod_end_y()` is removed. `rod_corners()[2]` becomes `rod_entry()`.
  - `module rod_solid()` builds the vertical run with `rod_top_end()` as its top, then the bend, then the forward run cut at the plane `fit / 2` behind the dock's back, then `ct_place() flange_local()`. The web into the plate is gone.
- **Produces** in `main-mount.scad`:
  - `module plate_part()`, `module rod_part()` and `module dock_part()`, in mounted coordinates, each with `cord_channel()` subtracted. `plate_part()` also subtracts `socket_negative()`.
  - `module mount_solid()` is their union, which `preview.scad` already uses.
  - `module mount_envelope()` keeps its meaning for the leak test: the parts' solids without their holes. That's `plate()`, `pocket_positive()`, `rod_solid()`, and `ct_place()` of the dock's plate and block.
  - `part` takes these values:
    - `"plate"`, the default: `as_owner() plate_part()`;
    - `"rod"`: `as_owner() rod_part()` (Task 4 moves it onto the bed);
    - `"dock"`: `as_owner() dock_part()` (Task 4 lays it on its back);
    - `"leak"`;
    - `"clash"`;
    - `"collide"`: the pairwise intersections of the three parts;
    - `"channel"`: `mount_solid()` intersected with `cord_channel(-0.2)`.
  - `"mount"` is removed.
- **Consumes:** `supports` from Task 1, which isn't used here yet.

- [ ] **Step 1: Write the failing rules in `checks.scad`.**

```openscad
assert(socket_depth >= rod_d, "the rod's socket is at least as deep as the rod is wide");
assert(flange_d >= rod_d_hidden + 12, "the flange is at least 12 mm wider than the rod");
assert(len([for (p = flange_rim_pts()) if (!hidden_from_eye(p)) p]) == 0, "the flange is hidden from the seat");
assert(min(rod_y() - (rod_d + fit) / 2 + plate_t + pocket[1],
           rod_x() - (rod_d + fit) / 2 - (pocket_x0() - wall),
           pocket_x0() + pocket[0] + wall - rod_x() - (rod_d + fit) / 2) >= 3,
       "the socket has 3 mm of base all round");
assert(-backplate_thickness() + spigot_len + 0.5 + 1 <= ct_port_y - plug_board[2] / 2 - 2.5,
       "the spigot's hole leaves a wall before the board pocket");
```

  - Delete the flare rule, which uses `rod_end_y()`.

- [ ] **Step 2: Write the failing tests in `test/mount.test.sh`.**

```bash
empty() { # label, part
  local log; log=$(openscad --backend=Manifold -o "$tmp/e.stl" -D "part=\"$2\"" "$mount/main-mount.scad" 2>&1)
  check "$1" "printf '%s' \"\$log\" | grep -q 'top level object is empty'"
}
empty "the three parts don't overlap when assembled" collide
empty "no part blocks the cord channel" channel
for p in plate rod dock; do part "$p" main-mount.scad -D "part=\"$p\""; done   # replaces: part main-mount main-mount.scad
catches "a shallow socket" -D socket_depth=12
catches "a narrow flange" -D flange_d=26
```

- [ ] **Step 3: Run `./test/mount.test.sh`.**
  - Expected FAILs:
    - `every geometry rule holds`, with an unknown variable `socket_depth`;
    - `collide`, `channel`, `rod renders` and `dock renders`.
  - Fix any FAIL that comes from a typo in the tests, not a missing feature, before going on.

- [ ] **Step 4: Implement the interfaces above.**
  - **The pocket's base:** in `lib/pocket.scad`, `pocket_positive()` now starts at z = 0, so the pocket box becomes a solid base.
  - **The cord path:** `cord_corners()` starts at `[rod_x(), rod_y(), cord_z_top()]`.
  - **The dock:** `dock_local()` also subtracts `spigot_hole_local()`.

- [ ] **Step 5: Run `./test/mount.test.sh`.**
  - Expected: every line `ok`, including the leak and clash tests and both `catches` lines.
  - The echo line from `checks.scad` must still show `sag` ≤ 0.1.

- [ ] **Step 6: Commit.** `feat(mount): split into plate, rod and dock with keyed glue joints`

---

### Task 3: The plate prints upright without supports

**Files:**
- Modify:
  - `lib/shelf.scad`
  - `lib/pocket.scad`
  - `main-mount.scad`: the ribs move into `lib/pocket.scad` as `module plate_ribs()`
  - `params.scad`: `pocket_post = 4`
  - `checks.scad`
  - `test/mount.test.sh`

**Interfaces:**
- **Produces** `module shelf_slot(len, base = 0)`.
  - `base` is how far below the floor's top the solid reaches.
  - At `base = 0` it's today's floor, which the standalone shelf uses.
  - At `base > 0`, the floor and a base block from z = −`base` to the floor fill the slot's whole depth. The plug opening is cut through the block from top to bottom, and the lip rises from the block's outer face.
  - `plate_part()` calls `shelf_slot(slot_len, base = shelf_z)`.
- **Produces** `pocket_negative()` with its open outer face split by a centre post `pocket_post` wide.
- **Produces** `module plate_ribs()`: the ribs at `rib_xs()`, each with its lower end angled at 45° back into the plate.

- [ ] **Step 1: Write the failing tests.**
  - In `test/mount.test.sh`, call `supports plate "$tmp/part.stl"` from `part()` for the plate.
  - In `checks.scad`, update the 30%-open rule so it subtracts the post:

```openscad
assert((pocket[0] - 2 * pocket_frame - pocket_post) * (pocket[2] - 2 * pocket_frame) >= 0.3 * pocket[0] * pocket[2],
       "at least 30% of the pocket's outer face is open");
assert(plate_h - plate_r - rib_z0 >= 30, "the ribs run at least 30 mm");
```

- [ ] **Step 2: Run `./test/mount.test.sh`.**
  - Expected FAILs:
    - `plate prints without big supports`, with supports of about 37 mm under the shelf, the ribs' lower ends and the bridge over the open face;
    - the 30%-open rule, because `pocket_post` is unknown.

- [ ] **Step 3: Implement.** Make the shelf base, the window post and the angled rib ends.

- [ ] **Step 4: Run `./test/mount.test.sh`.**
  - Expected: every line `ok`.
  - The plate's `supports:` line should report the longest bridge as the pocket's ceiling, about 28 mm.

- [ ] **Step 5: Commit.** `feat(mount): the plate prints upright without supports`

---

### Task 4: The rod and dock print in place without supports

**Files:**
- Modify:
  - `lib/rod.scad`: the keel, the wedge and the bed plane;
  - `lib/joint.scad`: `spigot_tip_z()`;
  - `main-mount.scad`: the print orientations for `rod` and `dock`;
  - `checks.scad`;
  - `test/mount.test.sh`.

**Interfaces:**
- **Produces** `function rod_bed_z() = rod_entry()[2] - rod_d_hidden / 2 - keel_gap`, the plane the rod part stands on.
- **Produces** `function rod_keel_pts()`: points along the keel's foot and the wedge's lower back edge, in mounted coordinates, every 5 mm.
- **Produces** `function spigot_tip_z()`: the lowest mounted z of the spigot's teardrop point.
- **`rod_solid()` adds:**
  - **The keel:** under the forward run, from where its sides reach 45° (`rod_d_hidden / 2 * cos(45)` below its axis), sloping in at 45° down to `rod_bed_z()`.
  - **The wedge:** under the bend's outer curve, from its 45° point down to `rod_bed_z()`. Its back face slopes at 45° and its sides follow the keel's.
  - The whole rod is then intersected with z ≥ `rod_bed_z()`. That also cuts the flange's bottom flat.
- **Print orientations:**
  - `"rod"`: `as_owner() translate([0, 0, -rod_bed_z()]) rod_part()`.
  - `"dock"`: `as_owner() translate([0, 0, backplate_thickness()]) rotate([90, 0, 0]) ct_unplace() dock_part()`. `ct_unplace()` moves the dock back into its local frame, and the rotation lays it on its back.

- [ ] **Step 1: Write the failing rules and tests.**

```openscad
assert(len([for (p = rod_keel_pts()) if (!hidden_from_eye(global_to_ct(p))) p]) == 0, "the rod's keel and wedge are hidden from the seat");
assert(spigot_tip_z() >= rod_bed_z() + 1, "the spigot's point stays above the rod's bed");
```

  - In `part()`, call `supports rod` and `supports dock` for those parts.

- [ ] **Step 2: Run `./test/mount.test.sh`.**
  - Expected FAILs: the rules, because `rod_keel_pts` is unknown, and `rod` and `dock prints without big supports`.

- [ ] **Step 3: Implement the interfaces above.**

- [ ] **Step 4: Run `./test/mount.test.sh`.**
  - Expected: every line `ok`.
  - **Rod extents:** about 40 × 67 × 77 mm.
  - **Dock extents:** about 108 × 56 × 18.4 mm, its back on the bed.
  - The dock's `supports:` line should show the nut pocket passing as a bridge over a small hole.

- [ ] **Step 5: Commit.** `feat(mount): the rod and dock print in place without supports`

---

### Task 5: Coupons, outputs and the README

**Files:**
- Modify: `coupons.scad`, `build.sh`, `test/mount.test.sh`, `README.md`.
- Modify: `docs/superpowers/specs/2026-11-05-mount-split-design.md`. Its dock section says the spigot hole "ends in a steep cone". Change that to "ends in a flat top, a bridge over a small hole", since the cone doesn't fit the dock's 14 mm.
- Delete: `stl/main-mount.stl`, `step/main-mount.step`, `stl/coupon-dock.stl`, `stl/coupon-rod.stl`.
- Regenerate: `stl/`, `step/`, `renders/`.

**Interfaces:**
- **Produces** in `coupons.scad`:
  - `part = "socket"`: a block cut from the plate's base around `socket_negative()`, with the channel. Next to it, a 30 mm stub of `rod_top_end()` stands on its cut end.
  - `"dock"` and `"rod"` are removed.
- **Produces** in `build.sh`:
  - STL and STEP for `plate`, `rod`, `dock` and `standalone-shelf`;
  - coupons `magnet`, `slot` and `socket`.

- [ ] **Step 1: Point the test's coupon loop at the new coupons.** In `test/mount.test.sh`, change it to `for c in magnet slot socket`. Run the tests: `coupon-socket renders` fails.

- [ ] **Step 2: Add the `socket` coupon and remove `dock` and `rod`.** Run the tests: every line `ok`.

- [ ] **Step 3: Update `build.sh` and regenerate the outputs.**
  - Point it at the new parts and coupons.
  - `git rm` the four retired outputs.
  - Run `./build.sh`. Every `step <part> faces … valid True` line must print.
  - `renders/seat.png` must be byte-identical to before (`git diff --stat renders/seat.png` shows nothing), since nothing visible changed.

- [ ] **Step 4: Update `README.md`.**
  - **Files table:** the three parts, and `test/supports.py`.
  - **Test list:** add "Prints without big supports" and the joint rules. Add the new `catches` cases to "It also checks…".
  - **Print:**
    - **Plate:** upright on its bottom edge.
    - **Rod:** standing on its keel. Put the slicer's seam on the side away from you (−y as mounted).
    - **Dock:** flat on its back.
    - **Standalone shelf:** on its end.
    - All four: a brim, and no supports.
  - **Coupons:** `magnet`, `slot` and `socket`. The `socket` test: the rod stub slides in by hand with room for glue, and only one way round.
  - **Parts:** a two-part epoxy for plastics.
  - **Assembly:** the spec's order.
    1. Fit the dock's magnet and try the dock on the Car Thing.
    2. Thread the wires through the loose rod and solder the board.
    3. Glue the rod to the dock, then pot the board.
    4. Glue the rod into the plate and let it cure 24 h.
    5. Solder the pocket's breakout, then mount.

- [ ] **Step 5: Run the full suite.**
  - Run `./test/mount.test.sh` and `git status`.
  - Expected: every line `ok`, and no stray outputs.

- [ ] **Step 6: Commit.** `docs(mount): coupons, exports and README for the three-part mount`
