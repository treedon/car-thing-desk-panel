# Mount Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the main mount so that from the owner's seat only a 16 mm round rod and the Car Thing show. The backplate, magnet and USB-C plug hide behind the Car Thing, and the plug sits in the recess on the Car Thing's back.

**Architecture:**
- The work stays in OpenSCAD under `hardware/mount/`.
- **New libraries:**
  - `lib/dock.scad`: the hidden backplate, the magnet seat and the plug block.
  - `lib/rod.scad`: the visible rod and the cord channel.
  - `lib/stiffness.scad`: an analytic estimate of how far the Car Thing moves under a button press.
- **Retired libraries:** `lib/arm.scad`, `lib/backplate.scad` and `lib/plug.scad`. The port-edge configurations go too.
- **Tests:** the geometry rules stay as asserts in `checks.scad`, run by `test/mount.test.sh`.

**Tech Stack:**
- OpenSCAD snapshot (`openscad --backend=Manifold --hardwarnings`).
- FreeCAD 1.1.4 `freecadcmd` for STEP export.
- Bash test harness.

**Spec:** [docs/superpowers/specs/2026-11-04-mount-redesign-design.md](../specs/2026-11-04-mount-redesign-design.md). It builds on [2026-11-03-monitor-mount-design.md](../specs/2026-11-03-monitor-mount-design.md).

## Global Constraints

- From the owner's seat, the only parts of the mount that show are the Car Thing and one round rod.
- **Rod:**
  - The visible rod is round, **16 mm in diameter**, with **one bend**.
  - It is **centred** behind the Car Thing.
  - It runs straight down behind the monitor, past the bottom edge, bends behind the Car Thing, and runs straight forward into the backplate.
- **Stiffness:**
  - A press of about **5 N** on the end button moves the Car Thing **≤ 0.1 mm**.
  - If that isn't met, thicken only the hidden parts. Everything stays PETG, with no metal core.
- **Backplate:**
  - It sits inside the Car Thing's outline as seen from the seat.
  - It is **no thicker than the rod (16 mm)**.
  - Its edges are rounded.
- **Magnet and plug:**
  - The magnet sits centred on the big pad, with **no plastic over the magnet face**.
  - The plug block sits in the recess. The block's shoulder is the **hard stop** at full insertion.
  - The block is narrower than the recess by at least the plug's engaged length plus clearance.
- **Docking:** slide the Car Thing toward the dial end to plug in. To remove it, slide it toward the big-pad end, then tip it off.
- **Carried over:** 15° tilt, Kuycon G27P (22 mm deep), PETG on a Prusa MK4 (each part fits 240 × 200 × 210 mm), STL and STEP exports, the shelf slot, the pocket and the standalone shelf (function unchanged).
- **Rounded everywhere:** no flat-faced box or sharp outer edge on any visible part, and the hidden parts are softened too.

## Coordinates

These definitions are used throughout the plan.

- **Global frame** (unchanged, see `params.scad`):
  - x points to the owner's right, with 0 at the plate's left edge;
  - y points toward the owner, with the monitor's back face at y = 0 and its screen at y = 22;
  - z points up, with the monitor's bottom edge at z = 0.
- **Car Thing local frame** (unchanged, see `lib/geometry.scad`):
  - x runs along the width, with 0 at the left edge **as seen from the front**;
  - y points out of the back toward the screen, with **y = 0 at the pad surface** and y = `ct_t` at the screen;
  - z points up the face, with 0 at the top edge and −`ct_h` at the bottom.
- **The back as seen from the front:** the big pad is at the left end (small x), the recess is in the middle, and the narrow pad and the dial are at the right end. The port is on the big pad's inner wall at x = `ct_recess[0]` and faces +x. The plug points −x.

## Review Focus

1. **Real measurements that don't fit.** If the recess is shallower than the block, the port sits off the block, or the travel doesn't clear, the rules must fail loudly. A quietly broken dock is the failure. *Pinned:* the Task 3 negative test.
2. **A seat off-centre or the mount further right** exposes the backplate's side. *Pinned:* the Task 1 `hidden_from_eye` unit asserts and the Task 3 negative test with `mount_x=320`.
3. **The cord channel in the thinner backplate** breaking into the magnet seat or the nut pocket. *Pinned:* Task 4 leak test, which includes the full `magnet_seat()`.
4. **The unplug slide** hitting the narrow pad, or the block reaching the recess floor. *Pinned:* the Task 3 asserts.
5. **Support marks or flattened faces on visible surfaces** in the chosen print orientation. *Reviewed by eye:* the Task 7 renders and README. No automated test.

---

### Task 1: Car Thing back, placement and the eye check

**Files:**
- Modify: `hardware/mount/params.scad` (Car Thing block, monitor block, owner's seat block)
- Modify: `hardware/mount/lib/geometry.scad`
- Modify: `hardware/mount/checks.scad`
- Test: `hardware/mount/test/mount.test.sh` (runs `checks.scad`)

**Interfaces:**
- Produces, in `params.scad`. Values marked MEASURE are read from the owner's photos.
  - Car Thing body: `ct_w = 120`, `ct_h = 64`, `ct_t = 20`, `ct_corner_r = 6`.
  - The three back zones, as x ranges in the local frame: `ct_pad_big = [4, 50]`, `ct_recess = [50, 96]`, `ct_pad_narrow = [96, 118]`.
  - `ct_recess_depth = 6`.
  - Port: `ct_port_z = 32` (port centre below the top edge); `ct_port_y = 3` (port centre's depth from the pad surface); `ct_port_depth = 7` (how deep the plug can go).
  - Tab and dial: `ct_tab = [32, 8, 3]` (centre below the top edge, height, how far it sticks out past x = 0); `ct_dial_overhang = 4`.
  - `ct_magnet_center = [(ct_pad_big[0] + ct_pad_big[1]) / 2, ct_h / 2]`.
  - Placement: `ct_top_gap = 6` (the Car Thing's top-front edge sits this far below the monitor's bottom edge); `ct_reach = 4`.
  - Seat: `mount_x = 150` (the Car Thing's centre, right of the monitor's centre); `eye` stays `[600, 150]`.
  - Removed: `bezel_gap`, `ct_top_drop`, `arm_reach`, `ct_port_offset`.
  - `ct_port_edge` and `ct_port_offset` stay until Task 4 removes them. Set `ct_port_offset = 58.5` until then, so the old parts still build.
- Produces, in `lib/geometry.scad`:
  - `ct_origin() -> [y, z]`: `[monitor_depth + ct_reach + backplate_thickness() * cos(tilt), -ct_top_gap - ct_t * sin(tilt)]`.
  - `global_to_ct(p) -> [x, y, z]`: the inverse of `ct_to_global`.
  - `eye_global() -> [x, y, z]`: `[ct_x0() + ct_w / 2 - mount_x, monitor_depth + eye[0], eye[1]]`.
  - `hidden_from_eye(p_local) -> bool`:
    - For a point with local y ≥ 0, true when it lies inside the outline: x in [`ct_corner_r`, `ct_w - ct_corner_r`] and z in [−`ct_h + ct_corner_r`, −`ct_corner_r`].
    - For a point with local y < 0, true when the segment from the eye (in the local frame) to the point crosses the plane y = 0 inside that same rectangle.

- [ ] **Step 1: Write the failing asserts** in `checks.scad`, in a new block headed `// The Car Thing's back and the owner's view`:

```scad
assert(ct_pad_big[1] == ct_recess[0] && ct_recess[1] == ct_pad_narrow[0], "the back's zones meet");
assert(ct_pad_narrow[1] <= ct_w, "the back's zones fit the body");
assert(ct_magnet_center[0] - magnet_d / 2 >= ct_pad_big[0] - 2 && ct_magnet_center[0] + magnet_d / 2 <= ct_pad_big[1] + 2,
       "the magnet sits on the big pad");
assert(hidden_from_eye([ct_w / 2, -1, -ct_h / 2]), "a point just behind the Car Thing's centre is hidden");
assert(!hidden_from_eye([ct_w / 2, -1, 10]), "a point above the Car Thing is visible");
assert(!hidden_from_eye([ct_w + 5, -1, -ct_h / 2]), "a point past its side is visible");
assert(norm(global_to_ct(ct_to_global([10, -3, -20])) - [10, -3, -20]) < 1e-6, "global_to_ct inverts ct_to_global");
```

- [ ] **Step 2: Run** `hardware/mount/test/mount.test.sh`. **Expected:** `FAIL ... every geometry rule holds`, with an unknown variable or function (`ct_pad_big`, `hidden_from_eye`).

- [ ] **Step 3: Implement** the parameters and the four functions above.
  - Use `ct_top_gap` in place of `bezel_gap + ct_top_drop` wherever old code used them.
  - In `lib/arm.scad`, replace the old arm's uses of `bezel_gap` with `ct_top_gap`, and of `arm_reach` with `ct_reach`. That keeps the old parts building until Task 4 deletes the file.

- [ ] **Step 4: Run** `hardware/mount/test/mount.test.sh`. **Expected:** every line is `ok`.
  - If an old-part rule fails *only* because of the new Car Thing size, ledger a ruling and relax that old rule. Task 4 deletes it anyway.

- [ ] **Step 5: Commit:** `feat(mount): Car Thing back zones, back port and eye-visibility check`.

---

### Task 2: Slim magnet seat

**Files:**
- Modify: `hardware/mount/params.scad` (Magnet block)
- Modify: `hardware/mount/lib/geometry.scad` (`backplate_thickness`)
- Modify: `hardware/mount/lib/magnet.scad`
- Modify: `hardware/mount/checks.scad` (Magnet block)

**Interfaces:**
- Produces, in `params.scad`: `rod_d = 16`, `magnet_web = 2` (plastic between the magnet pocket and the nut pocket), `nut_cover = 0` (the nut pocket opens on the hidden back).
- Produces, in `lib/geometry.scad`: `backplate_thickness()` is now `magnet_t + magnet_web + nut_t + 0.4`, about 14.1 mm.
- Produces, in `lib/magnet.scad`:
  - `stud_cut() -> mm`: the length the owner cuts the stud to, `backplate_thickness() - magnet_t - 0.5`.
  - `magnet_seat()` keeps its frame: the magnet pocket is `magnet_t` deep from the face, the stud hole goes all the way through, and the hex nut pocket sits at the back.

- [ ] **Step 1: Write the failing asserts.** Replace the old block "The magnet grips the Car Thing directly…" in `checks.scad` with:

```scad
assert(magnet_pocket_depth() == magnet_t, "no plastic over the magnet face");
assert(backplate_thickness() <= rod_d, "the backplate is no thicker than the rod");
assert(backplate_thickness() - magnet_t - nut_t - 0.4 >= magnet_web, "a web between the magnet and the nut");
assert(stud_cut() >= magnet_web + nut_t, "the cut stud still passes through the nut");
assert(stud_cut() <= backplate_thickness() - magnet_t, "the cut stud stays inside the backplate");
```

- [ ] **Step 2: Run** the harness. **Expected:** `FAIL`, because `rod_d` and `stud_cut` are undefined.

- [ ] **Step 3: Implement** the parameters and functions above. Remove `stud_len` from the asserts, but keep it in `params.scad`: the README tells the owner to cut it down.

- [ ] **Step 4: Run** the harness. **Expected:** every line is `ok`.

- [ ] **Step 5: Commit:** `feat(mount): slim magnet seat with a cut stud`.

---

### Task 3: The dock (hidden backplate with the plug block)

**Files:**
- Create: `hardware/mount/lib/dock.scad`
- Modify: `hardware/mount/params.scad` (new Dock block)
- Modify: `hardware/mount/coupons.scad` (add `part = "dock"`)
- Modify: `hardware/mount/checks.scad`
- Modify: `hardware/mount/test/mount.test.sh` (dock coupon, negative test)

**Interfaces:**
- Consumes:
  - from Task 1: `ct_*`, `hidden_from_eye`;
  - from Task 2: `backplate_thickness()`, `magnet_seat()`;
  - the plug parameters already in `params.scad`: `plug_w`, `plug_t`, `plug_len`, `plug_board`, `plug_shoulder`, `fit`, `wall`.
- Produces, in `params.scad`: `bp_inset = 8` (the backplate outline sits this far inside the Car Thing's) and `bp_r = 6` (its corner radius and edge round).
- Produces, in `lib/dock.scad`, all in the Car Thing's local frame:
  - `dock_block_len() -> mm` = `plug_board[1] + plug_shoulder`. This is the block's length along x, measured from the port wall.
  - `dock_engaged() -> mm` = `plug_len - plug_shoulder`. This is how far the plug goes into the port.
  - `dock_block_front() -> mm` = `ct_port_y + max(plug_t / 2, plug_board[2] / 2 + fit) + wall`. This is the block's furthest local y.
  - `dock_block_half_h() -> mm` = `plug_board[0] / 2 + fit + wall`.
  - `dock_cord_end() -> [x, y, z]` = `[ct_w / 2, ct_port_y - plug_board[2] / 2 - 1.5, -ct_port_z]`. This is where the cord channel ends, behind the board.
  - `dock_outline_pts() -> [[x, y, z], …]`: the points the visibility rule tests.
    - The backplate's outline corners at y = −`backplate_thickness()` and at y = 0.
    - The block's eight corners.
  - `module dock_local()`:
    - **Plate:** a rounded slab spanning x [`bp_inset`, `ct_w - bp_inset`] and z [−`ct_h + bp_inset`, −`bp_inset`], with y from −`backplate_thickness()` to 0. Its corners are rounded by `bp_r` and its back edges by `bp_r / 2`.
    - **Block:** in the recess, spanning x [`ct_recess[0] + fit`, `ct_recess[0] + dock_block_len()`] and y [0, `dock_block_front()`], with z within ±`dock_block_half_h()` of −`ct_port_z`. Its outer edges are rounded by 1 mm.
    - **Magnet seat** at `ct_magnet_center`, as the old `backplate_local` placed it.
    - **Board pocket:**
      - The board lies in the x–z plane at y = `ct_port_y`, with its plug pointing −x through a shoulder slot `plug_shoulder` thick at the block's −x face.
      - The pocket is open at the block's bottom (−z), so the board slides in, and is closed at +x.
      - The shoulder slot is open to the bottom too.
      - There is 2.5 mm behind the board, on the −y side, for the solder joints.
- Produces: the `dock` coupon in `coupons.scad`, which is `dock_local()` alone, for a fit test on the real Car Thing.

- [ ] **Step 1: Write the failing asserts** in `checks.scad`, in a block headed `// The dock behind the Car Thing`:

```scad
assert(dock_block_front() <= ct_recess_depth - fit, "the block clears the recess floor");
assert(ct_recess[1] - ct_recess[0] - dock_block_len() - fit >= dock_engaged() + fit,
       "the Car Thing slides far enough to unplug before the narrow pad meets the block");
assert(dock_engaged() >= 4 && dock_engaged() <= ct_port_depth, "the plug engages 4 mm or more and the shoulder stops it first");
assert(dock_block_half_h() <= ct_port_z - ct_corner_r && dock_block_half_h() <= ct_h - ct_port_z - ct_corner_r,
       "the block stays inside the recess's height");
// The tab sticks out past x = 0, so staying inside the outline keeps the plate off it.
assert(bp_inset >= 2, "the backplate stays off the tab and the body's rounded edge");
assert(len([for (p = dock_outline_pts()) if (!hidden_from_eye(p)) p]) == 0, "the dock is hidden from the seat");
```

- [ ] **Step 2: Add a negative test** to `test/mount.test.sh`. Rendering `checks.scad` with each of these must **fail** the rules. Print `ok   rules catch <label>` when the render fails, and `FAIL` when it passes.
  - `-D ct_recess_depth=3`, label `a shallow recess`;
  - `-D mount_x=320`, label `a seat far off to the side`.

- [ ] **Step 3: Run** the harness. **Expected:** `FAIL`, because `dock_block_front` is undefined. The negative tests print `ok` for the wrong reason, which is acceptable here because the undefined function already fails the render.

- [ ] **Step 4: Implement** `lib/dock.scad` and include it in `checks.scad` and `coupons.scad`. Add `dock` to the coupon loop in `test/mount.test.sh` and `build.sh`.

- [ ] **Step 5: Run** the harness. **Expected:**
  - `ok   every geometry rule holds`;
  - `ok   rules catch a shallow recess`;
  - `ok   rules catch a seat far off to the side`;
  - `ok` on all three of: `coupon-dock renders`, `coupon-dock fits the MK4`, `coupon-dock is a single closed solid`.
  - If the `mount_x=320` case still passes, `hidden_from_eye` or `dock_outline_pts` is wrong. Fix it; do not change the test.

- [ ] **Step 6: Commit:** `feat(mount): hidden dock with the plug block in the Car Thing's recess`.

---

### Task 4: The rod, the cord channel and the switch-over

**Files:**
- Create: `hardware/mount/lib/rod.scad`
- Modify: `hardware/mount/main-mount.scad`
- Modify: `hardware/mount/lib/geometry.scad` (`ct_x0`, `lowest_z`; remove `ledge_h`)
- Modify: `hardware/mount/lib/pocket.scad` (`pocket_x0`)
- Modify: `hardware/mount/coupons.scad` (`cord` becomes `rod`; remove `plug`)
- Modify: `hardware/mount/checks.scad`
- Modify: `hardware/mount/test/mount.test.sh`
- Modify: `hardware/mount/build.sh`
- Modify: `hardware/mount/params.scad` (Rod block; remove `ct_port_edge`, `ct_port_offset`, `arm_w`, `arm_t`)
- Delete: `hardware/mount/lib/arm.scad`, `hardware/mount/lib/backplate.scad`, `hardware/mount/lib/plug.scad`

**Interfaces:**
- Consumes:
  - from Task 3: `dock_local()`, `dock_cord_end()`;
  - from Task 1: `ct_to_global`, `ct_place`, `hidden_from_eye`, `global_to_ct`.
- Produces, in `params.scad`:
  - `rod_bend_r = 14`: the radius of the rod's centreline at the bend. It must be at least `cord_bend_r`, and greater than the rod's radius.
  - `rod_d_hidden = rod_d`: Task 5 raises this.
  - `$fn_rod = 96`.
- Produces, in `lib/pocket.scad`: `pocket_x0() = plate_w - pocket[0] - wall`.
- Produces, in `lib/rod.scad`:
  - `rod_x() -> mm` = `pocket_x0() + pocket[0] / 2`.
  - `ct_x0()`, in `geometry.scad`: `rod_x() - ct_w / 2`. The rod is centred on the Car Thing, and the Car Thing may overhang the plate's right edge.
  - `rod_y() -> mm` = `-plate_t - rod_d_hidden / 2 + 1`. The vertical run is fused 1 mm into the plate's back.
  - `rod_entry() -> [x, y, z]` = `ct_to_global([ct_w / 2, -backplate_thickness(), -ct_h / 2])`. The forward run is the horizontal line at `rod_entry()[2]`.
  - `rod_corners() -> [[x, y, z] ×3]`: the top `[rod_x(), rod_y(), pocket_z0 + 4]`, the bend `[rod_x(), rod_y(), rod_entry()[2]]`, and the end `rod_entry() + [0, 2, 0]`, which runs 2 mm into the backplate.
  - `module rod_solid()`:
    - straight cylinders for the two runs and a `rotate_extrude(angle = 90)` torus section for the bend, at `$fn = $fn_rod`;
    - a smooth flare to `rod_d_hidden + 8` where it meets the backplate's back;
    - a fillet of radius ≥ 4 where the vertical run meets the plate.
  - `cord_corners()`: `rod_corners()` up to the bend, then `rod_entry()`, then `ct_to_global(dock_cord_end())`, with `dedupe` applied.
  - `cord_channel(margin)`: unchanged signature, `tube(round_path(cord_corners(), cord_bend_r), cord_d + 1 + 2 * margin)`.
  - `rod_visible_pts() -> [[x, y, z] …]`: points on the forward run's top line, at the forward run's z + `rod_d_hidden / 2`, sampled every 5 mm from the bend's end to `rod_entry()`. They are given in **global** coordinates, and the check converts them with `global_to_ct`.

- [ ] **Step 1: Write the failing asserts.**
  - Delete the old asserts in `checks.scad` that mention `ct_port_edge`, `ledge_h`, `bezel_gap`, `arm_x`, `arm_w` or `arm_x_local`.
  - Change the backplate-and-ledge assert to the dock outline staying within `ct_x0()` and `ct_x0() + ct_w`.
  - Change `lowest_z()` to the Car Thing's corners alone.
  - Add:

```scad
assert(rod_bend_r >= cord_bend_r && rod_bend_r > rod_d_hidden / 2, "the rod's bend takes the cord and isn't self-intersecting");
assert(path_fits(cord_corners(), cord_bend_r), "cord bends without kinking");
assert(rod_entry()[2] < -ct_top_gap - rod_bend_r, "the bend sits below the Car Thing's top, behind it");
assert(len([for (p = rod_visible_pts()) if (!hidden_from_eye(global_to_ct(p))) p]) == 0,
       "the rod's forward run is hidden behind the Car Thing");
assert(abs(rod_x() - (ct_x0() + ct_w / 2)) < 0.01, "the rod is centred on the Car Thing");
assert(pocket_x0() - wall >= shelf_x0() + slot_len, "the pocket clears the shelf");
```

- [ ] **Step 2: Change the harness.**
  - Replace the `configs` loop in `test/mount.test.sh` with a single run: rules, leak and main-mount, with no `-D` arguments.
  - In `main-mount.scad`'s `leak` part, intersect the channel with the **whole** `magnet_seat()`, including the nut pocket.

- [ ] **Step 3: Run** the harness. **Expected:** `FAIL`, because `rod_entry` and `rod_visible_pts` are undefined.

- [ ] **Step 4: Implement:**
  - `lib/rod.scad`.
  - `main-mount.scad`: `mount_solid()` is `plate()`, `pocket_positive()`, the shelf slot, `rod_solid()` and `ct_place() dock_local()`, minus `pocket_negative()`. `mount_envelope()` uses the same bodies without the cuts.
  - Delete the three old libraries.
  - Update `coupons.scad`: the `rod` coupon is 30 mm of each run around the bend with its channel, and replaces `cord`. Remove `plug`.
  - Update `build.sh`: the coupon list is `magnet dock slot rod`.

- [ ] **Step 5: Run** the harness. **Expected:** every line is `ok`, including:
  - `at least 1.2 mm of wall around the cord channel`;
  - `main-mount fits the MK4`;
  - `main-mount is a single closed solid`.

- [ ] **Step 6: Commit:** `feat(mount): single-bend 16 mm rod into the hidden dock; retire the arm and ledge`.

---

### Task 5: Stiffness under a button press

**Files:**
- Create: `hardware/mount/lib/stiffness.scad`
- Modify: `hardware/mount/lib/rod.scad` (taper from `rod_d` to `rod_d_hidden`)
- Modify: `hardware/mount/params.scad` (`rod_d_hidden`, Stiffness block)
- Modify: `hardware/mount/checks.scad`

**Interfaces:**
- Consumes from Task 4: `rod_corners()`, `rod_entry()`, `rod_y()`.
- Produces, in `params.scad`:
  - `petg_E = 2000` and `petg_G = 750` (MPa);
  - `press_N = 5`;
  - `button_x_off = 45` (the end button's distance from the rod's axis, along x);
  - `sag_max = 0.1`.
- Produces, in `lib/stiffness.scad`:
  - `rod_I(d) = PI * (pow(d, 4) - pow(cord_d + 1, 4)) / 64`.
  - `button_sag() -> mm`: the sum of four terms. `Lf` is the forward run's length from the bend to `rod_entry()`. `Lv` is the vertical run's free length, from z = 0 to the bend.
    1. The forward run bending: `F·Lf³ / (3·E·I(d_h))`.
    2. The vertical run bending under `F·Lf`, rotated through `Lf`: `F·Lf·Lv / (E·I(d_v))·Lf`.
    3. The forward run twisting under `F·e`, seen at `e`: `F·e·Lf / (G·2I(d_h))·e`.
    4. The vertical run bending sideways under `F·e`, seen at `e`: `F·e·Lv / (E·I(d_v))·e`.
  - In those terms, `d_h = rod_d_hidden`, and `d_v` is the vertical run's diameter. That is `rod_d` from z = 0 down to the Car Thing's top line, then `rod_d_hidden`. Use `rod_d` for `d_v`, to be conservative.

- [ ] **Step 1: Write the failing assert:**

```scad
assert(button_sag() <= sag_max, str("a 5 N press on the end button moves the Car Thing ", button_sag(), " mm"));
```

- [ ] **Step 2: Run** the harness. **Expected:** `FAIL`, with a sag of about 0.15–0.2 mm at the uniform 16 mm.

- [ ] **Step 3: Implement** `button_sag()` and the taper.
  - The rod is `rod_d` from the plate down to 2 mm below the line where `hidden_from_eye` starts to hold. Below that it tapers smoothly over the bend to `rod_d_hidden`.
  - Raise `rod_d_hidden` (up to 24) and reduce `ct_reach` (down to 0) until the assert holds. Never change `rod_d`.
  - The Task 4 visibility asserts must still hold.
  - **If no allowed combination reaches 0.1 mm,** set the best one, ledger a ruling with the value it reaches, and report it to the owner. Don't loosen `sag_max`.

- [ ] **Step 4: Run** the harness. **Expected:** every line is `ok`.

- [ ] **Step 5: Commit:** `feat(mount): stiffness check; thicken the rod where it's hidden`.

---

### Task 6: Soften the hidden parts

**Files:**
- Modify: `hardware/mount/main-mount.scad` (`plate()`)
- Modify: `hardware/mount/lib/pocket.scad`
- Modify: `hardware/mount/lib/shelf.scad`
- Modify: `hardware/mount/standalone-shelf.scad`
- Modify: `hardware/mount/params.scad` (`soft_r = 2`, `plate_r = 10`)
- Modify: `hardware/mount/checks.scad`

**Interfaces:**
- Produces:
  - **Plate:** a rounded rectangle with corner radius `plate_r`, and its back edges rounded by `soft_r`. The adhesive face stays flat.
  - **Ribs:** keep the old ribs, but round their ends and edges by `soft_r`.
  - **Pocket:** its outer box has its edges rounded by `soft_r`, made as a hull of spheres or by offsetting.
  - **Shelf slot:** a fillet of radius `soft_r` where the floor meets the plate and the lip meets the floor, the notch's ends rounded, and the lip's top edge rounded.
  - **Standalone shelf:** its plate is rounded the same way.

- [ ] **Step 1: Write the failing asserts:**

```scad
assert(plate_r >= 8 && soft_r >= 1.5, "the plate and every hidden edge are rounded");
assert(standalone_r() >= 8, "the standalone shelf's plate is rounded");
```

with `standalone_r()` defined in `lib/shelf.scad`.

- [ ] **Step 2: Run** the harness. **Expected:** `FAIL`, because `plate_r` is undefined.

- [ ] **Step 3: Implement** the softening above. The adhesive faces (y = 0 on both plates) stay flat across their full area, apart from the corner radius.

- [ ] **Step 4: Run** the harness. **Expected:** every line is `ok`, including both parts being `single closed solid`.

- [ ] **Step 5: Commit:** `feat(mount): round and fillet the plate, pocket and shelves`.

---

### Task 7: Renders, exports and the README

**Files:**
- Create: `hardware/mount/preview.scad` (the mount plus a stand-in Car Thing and monitor, for renders only)
- Modify: `hardware/mount/build.sh` (renders into `renders/`)
- Modify: `hardware/mount/README.md`
- Regenerate: `hardware/mount/stl/*`, `hardware/mount/step/*`, `hardware/mount/renders/{seat,side,back}.png`

**Interfaces:**
- `preview.scad` includes `main-mount.scad`'s bodies plus `ct_mock()`, which models:
  - the Car Thing's body with `ct_corner_r`;
  - the three back zones;
  - the dial on the top edge at the narrow-pad end;
  - a monitor slab.
- **Renders:**
  - `seat`: the camera at `eye_global()`, looking at the Car Thing's centre, perspective.
  - `side`: from +x, orthographic.
  - `back`: from behind and below, showing the dock.

- [ ] **Step 1: Write the failing test.** Add to `test/mount.test.sh`: `check "preview renders" "openscad --hardwarnings -o $tmp/seat.png --camera=… $mount/preview.scad"`. Build the camera from `eye_global()` values that `checks.scad` echoes, or from fixed numbers kept next to the defaults in `params.scad`.

- [ ] **Step 2: Run** the harness. **Expected:** `FAIL`, because `preview.scad` doesn't exist.

- [ ] **Step 3: Implement** `preview.scad` and the render step in `build.sh`. Then **choose the print orientation:**
  - Support marks and any flattened face may fall only on surfaces hidden from the seat: the rod's underside, the side facing the monitor, and the backplate's back.
  - Ledger it as a ruling.

- [ ] **Step 4: Rewrite the README's Print, Parts and Assembly sections** for the new design.
  - **Filament:** matte black PETG.
  - **Coupons:** `magnet`, `dock` (try it on the real Car Thing: the block sits in the recess, the plug seats, and it slides off), `slot` and `rod`.
  - **Cutting the stud:** cut it to `stud_cut()` mm (echo the value) before fitting the magnet.
  - **Board:** slide it into the block from below, check continuity, then fill with epoxy.
  - **Docking:** put the Car Thing on the magnet a few mm toward the big-pad end, then slide it toward the dial end until it stops.
  - **Removal:** slide it toward the big-pad end, then tip the dial end away.
  - **MEASURE list:** list every MEASURE parameter, so the owner measures them before the full print.

- [ ] **Step 5: Run** `hardware/mount/build.sh`, then the harness. **Expected:**
  - every harness line is `ok`;
  - `build.sh` prints `step main-mount faces … valid True` and `step standalone-shelf faces … valid True`;
  - all three PNGs exist.
  - Read `renders/seat.png`: only the rod and the Car Thing show. If anything else shows, the visibility rules are wrong. Fix them and go back to the task that owns them.

- [ ] **Step 6: Commit:** `docs(mount): renders, exports and README for the redesign`.
