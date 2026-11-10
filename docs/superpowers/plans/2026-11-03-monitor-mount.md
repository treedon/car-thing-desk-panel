# Monitor Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parametric OpenSCAD models for the adhesive monitor mount: the main mount (plate, hidden-cord arm, 15° magnet backplate with a fixed USB-C plug, an electronics pocket and one shelf slot) and a standalone shelf. STL and STEP exports print on a Prusa MK4 in PETG.

**Architecture:** One `params.scad` holds every dimension. Small modules (`lib/`) build the magnet seat, the plug holder and the shelf slot. Two top-level files assemble the printable parts. `checks.scad` turns the spec's geometric rules into OpenSCAD `assert()`s. A bash test renders every part and checks the asserts and bed fit, in the style of `device/test/provision.test.sh`. Measured values come from the owner in Task 2, and printed fit coupons (Task 3) confirm them before the full parts are printed.

**Tech Stack:** OpenSCAD 2021.01+ (CLI); FreeCAD's `freecadcmd` for STL→STEP; bash and awk for tests; PrusaSlicer for printing.

**Spec:** [docs/superpowers/specs/2026-11-03-monitor-mount-design.md](../specs/2026-11-03-monitor-mount-design.md)

## Global Constraints

- PETG, Prusa MK4. Every part's XY footprint ≤ **240 × 200 mm**. Main mount prints in **one piece**.
- Monitor: Kuycon G27P, **22 mm** deep, back **entirely flat**.
- Gap between the monitor's bottom edge and the arm: **4 mm** (parameter).
- Backplate tilt: **15°** back, measured **from the screen's plane** (parameter).
- Magnet: Magnetpro pot magnet, **43 mm** (1.69 in) diameter, **6.1 mm** (0.24 in) thick, **1/4"-20** stud **12.7 mm** (0.5 in) long. Held by a 1/4-20 nut in a hex pocket. **No plastic over the magnet face.**
- USB-C plug **fixed to the backplate**. The Car Thing **slides on and off along the plug axis**. Plug wiring per [docs/hardware/pogo-dock.md](../../hardware/pogo-dock.md) (VBUS, GND, D+, D−, CC; CC resistor removed).
- Shelf slots: **114.3 mm** (4.5 in) long, for items **19.05 mm** (3/4 in) thick. Floor plus a lip on the long side, **no end walls**, a cable notch, port edges clear.
- One slot on the main mount; a second **standalone** shelf with its own plate.
- Mount sits **off to the right side** of the monitor.
- Adhesive: 3M VHB over each plate's whole back face. Plate ≥ **4 mm** PETG, ribbed if needed, as tall as practical.
- The charge-through cable and dongle live in a pocket behind the monitor, **open or vented** on its outer face.
- Exports: **STL and STEP**. OpenSCAD can't write STEP, so STEP is converted from STL with FreeCAD. It is faceted but opens in Fusion.

## Coordinate convention (all files)

Origin at the monitor's bottom edge, on its back face, at the mount's left edge. **+X** runs along the monitor's width, to the owner's right. **+Y** points toward the owner, so the screen face is at `y = monitor_depth`. **+Z** points up, so the monitor's bottom edge is `z = 0`. The plate's adhesive face lies at `y = 0`, and the plate grows into −Y.

## Review Focus

1. **The Car Thing slides off under gravity.** If the port is on the Car Thing's top edge, the slide-off direction is downward. Expect it to stay put. `checks.scad` asserts that the plug axis has no downward release component, or that a stop is modeled (Task 4).
2. **Peel from a heavy shelf item.** Expect the plate to hold 2 × 300 g items indefinitely. `checks.scad` asserts that the plate is at least 3× taller than the shelf's Y overhang (Task 5). A physical hang test covers the rest (Task 6).
3. **Plug misalignment strains the Car Thing's port.** Expect it to slide on with no force at the end of travel. The coupon test in Task 3 checks the plug height against the magnet face to ±0.3 mm.
4. **The cord kinks at the arm's bend.** Expect the cord to thread through without force. `checks.scad` asserts that the channel bend radius ≥ `cord_bend_r` (Task 4), and Task 6 threads the real cord.
5. **The Car Thing covers the screen or hits the desk.** `checks.scad` asserts that the Car Thing's top is below `z = 0`, that the sight line from `eye` to the bezel clears it, and that its lowest point is above `-desk_clear` (Task 4).

---

## File Structure

```
hardware/mount/
  params.scad            all dimensions; MEASURE markers for owner-supplied values
  lib/magnet.scad        magnet_seat() — pocket, stud hole, nut hex
  lib/plug.scad          plug_holder() — rigid USB-C plug breakout cradle
  lib/shelf.scad         shelf_slot(len) — floor, lip, cable notch
  lib/geometry.scad      functions: car thing corners after tilt, sight line, plate checks
  coupons.scad           fit coupons (magnet, plug, slot, cord channel)
  main-mount.scad        plate + arm + backplate + pocket + one slot
  standalone-shelf.scad  plate + one slot
  checks.scad            assert()s on lib/geometry.scad
  build.sh               renders STL to hardware/mount/stl/, converts STEP to hardware/mount/step/
  test/mount.test.sh     renders, runs checks, checks bed fit
  README.md              print settings, assembly, wiring
```

---

### Task 1: Tooling, parameters and test harness

**Files:**
- Create: `hardware/mount/params.scad`, `hardware/mount/lib/geometry.scad`, `hardware/mount/checks.scad`, `hardware/mount/test/mount.test.sh`

**Interfaces:**
- Produces: every parameter below by name; `function ct_corners()` → list of the four `[y, z]` corners of the Car Thing's side profile after tilt; `function bbox_ok(stl)` in the test script.

- [ ] **Step 1:** Install the tools: `brew install --cask openscad freecad`. Check with `openscad --version` and `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd --version`.
- [ ] **Step 2:** Write `params.scad` with these names and defaults. Values marked `// MEASURE` are placeholders until Task 2.
  - Monitor: `monitor_depth = 22; bezel_gap = 4; tilt = 15;`
  - Car Thing: `ct_w = 117; ct_h = 80; ct_t = 18; // MEASURE`. Then `ct_port_edge = "bottom"; // MEASURE: "top"|"bottom"|"left"|"right"`, plus `ct_port_offset` (port center from that edge's left end) and `ct_port_y` (port center from the back face). Then `ct_magnet_center = [ct_w/2, ct_h/2]; // MEASURE best spot`.
  - Magnet: `magnet_d = 43; magnet_t = 6.1; stud_d = 6.35; stud_len = 12.7; nut_af = 11.11; nut_t = 5.56; fit = 0.3;`
  - Plug: `plug_w = 9; plug_t = 3.3; plug_len = 6.5; plug_board = [12, 15, 1.6]; // MEASURE breakout`
  - Cord: `cord_d = 4; cord_bend_r = 10; // MEASURE`
  - Plate and arm: `plate_t = 4; plate_w = 200; plate_h = 120; arm_w = 22; wall = 2.4;`
  - Shelf: `slot_len = 114.3; item_t = 19.05; slot_clear = 1.5; lip_h = 7; floor_t = 3; notch_w = 12;`
  - Pocket: `pocket = [60, 30, 22]; // MEASURE contents`
  - Owner position: `eye = [600, 150]; // [distance from screen, height above bottom edge] MEASURE`, `desk_clear = 120; // MEASURE`
  - Bed: `bed = [240, 200];`
- [ ] **Step 3:** Write `lib/geometry.scad`. `ct_corners()` rotates the Car Thing's rectangle (thickness `ct_t` along Y, height `ct_h` along Z) about the backplate's top-front pivot by `tilt`, leaning back. It places the top-front corner at `z = -bezel_gap - 2`.
- [ ] **Step 4:** Write `checks.scad` with `include <params.scad>`, `include <lib/geometry.scad>`, and one `assert()` per Review Focus item 5 rule:
  - Car Thing's max z `< 0`;
  - the line from `[monitor_depth + eye[0], eye[1]]` to `[monitor_depth, 0]` lies above every Car Thing corner;
  - min z `> -desk_clear`.
  Each assert message names the rule.
- [ ] **Step 5:** Write `test/mount.test.sh`, using the same `check` helper as `device/test/provision.test.sh`. It runs `openscad -o /dev/null checks.scad` and expects exit 0 with no `ERROR` in stderr. For each `*.scad` that has a top-level part, it renders to a temp ASCII STL, computes the X and Y extents with awk over `vertex` lines, and checks them against `bed` (240 × 200, either orientation).
- [ ] **Step 6:** Run `hardware/mount/test/mount.test.sh`. Expect the checks to pass with the placeholder values. Then break a check: set `tilt = 60` temporarily, confirm the screen-clearance assert fails with its message, and revert.
- [ ] **Step 7:** Commit: `git add hardware/mount && git commit -m "feat(mount): parameters, geometry checks and test harness"`

### Task 2: Owner measurements (manual, owner runs this)

**Files:** Modify `hardware/mount/params.scad` (every `// MEASURE` line).

- [ ] **Step 1:** Owner measures with calipers and reports:
  - **Car Thing:** width, height and thickness. Which edge the USB-C port is on, the port's center offset along that edge, and its depth from the back face. The best flat spot on the back for the magnet.
  - **USB-C plug breakout:** plug width, thickness and length, and board size.
  - **Cord:** diameter, and the bend radius it takes without force.
  - **Pocket contents:** the splitter head, the C-to-A adapter, the dongle and the coiled flat cable, laid out as they'll sit.
  - **Desk:** height from the monitor's bottom edge to the desk. Eye height above the bottom edge and viewing distance.
  - **Monitor:** bottom bezel height, the back's finish (smooth, textured or coated), where the stand attaches on the right half, and any vents.
  - **Dongle:** the model number, to confirm it's the Wi-Fi model, not the UB500.
- [ ] **Step 2:** Enter the values and remove the `// MEASURE` markers. Run `hardware/mount/test/mount.test.sh` and expect all checks to pass. A failing check is a design conflict: stop and bring it to the owner.
- [ ] **Step 3:** Commit: `git commit -am "feat(mount): measured dimensions"`

### Task 3: Fit coupons

**Files:**
- Create: `hardware/mount/lib/magnet.scad`, `hardware/mount/lib/plug.scad`, `hardware/mount/lib/shelf.scad`, `hardware/mount/coupons.scad`

**Interfaces:**
- Produces:
  - `magnet_seat()`: a negative volume, with its face plane at z = 0 and pointing +Z. It has a `magnet_d + fit` pocket `magnet_t` deep, open at the face, a `stud_d + fit` through-hole, and a nut hex (`nut_af + fit` across flats, `nut_t + 0.4` deep) from the back.
  - `plug_holder()`: a positive cradle plus a negative cutout. The plug's centerline sits at `ct_port_y` from the magnet face, and the plug sticks out `plug_len`.
  - `shelf_slot(len)`: a positive part with a floor `len × (item_t + slot_clear)`, a lip of height `lip_h` on the far long edge, and a `notch_w` cable notch centered in the lip. It has no end walls.
  - `backplate_thickness()`: the function `= magnet_t + max(2, stud_len - magnet_t - nut_t + 1) + nut_t`. It makes sure the stud never pokes out of the back.
- Consumes: `params.scad`.

- [ ] **Step 1:** Add to `checks.scad`:
  - `assert(backplate_thickness() >= stud_len - 0.5, "stud stays inside the backplate")`;
  - `assert(shelf inner width == item_t + slot_clear)`;
  - `assert(magnet pocket depth == magnet_t, "no plastic over the magnet face")`.
  Run the test and expect it to fail, because the functions aren't defined yet.
- [ ] **Step 2:** Implement the three modules and the function. Run the test and expect it to pass.
- [ ] **Step 3:** Build `coupons.scad`, with a part selected by `-D part="..."`:
  - `magnet`: a 55 mm square backplate section with `magnet_seat()`.
  - `plug`: a backplate section with `magnet_seat()` and `plug_holder()`.
  - `slot`: `shelf_slot(30)` on a 30 mm plate stub.
  - `cord`: a 60 mm arm section with the bent channel.
- [ ] **Step 4:** Print all four in PETG and check them:
  - **Magnet:** it seats flush, the stud and nut tighten, and the face is bare.
  - **Plug:** with the Car Thing on the magnet, it slides onto the plug with no force at the end of travel, and the plug sits within ±0.3 mm of the port.
  - **Slot:** the item drops in without binding and stays upright.
  - **Cord:** the real cord threads through.
  Adjust `fit`, `ct_port_y` and `cord_bend_r` until all four pass. Record the final values in `params.scad`.
- [ ] **Step 5:** Commit: `git add hardware/mount && git commit -m "feat(mount): magnet, plug and shelf modules with fit coupons"`

### Task 4: Main mount — plate, arm and backplate

**Files:**
- Create: `hardware/mount/main-mount.scad`
- Modify: `hardware/mount/checks.scad`

**Interfaces:**
- Consumes: `magnet_seat()`, `plug_holder()`, `backplate_thickness()`, `ct_corners()`.
- Produces: `main_mount()` (the whole printable part) and `arm_channel_path()` (a list of points for the cord channel).

- [ ] **Step 1:** Add to `checks.scad`:
  - `assert(ct_port_edge != "top" || stop_modeled, "Car Thing can't slide off downward")`;
  - `assert(min channel bend radius >= cord_bend_r, "cord bends without kinking")`;
  - `assert(arm top z == -bezel_gap)`.
  Run the test and expect it to fail.
- [ ] **Step 2:** Implement `main_mount()`:
  - **Plate:** `plate_w × plate_h × plate_t` at `y ∈ [-plate_t, 0]`, with its bottom at `z = 0`. Add ribs on the −Y face if the plate's span between supports is more than 60 mm.
  - **Arm:** it drops from the plate to `z = -bezel_gap - arm thickness`, runs +Y under the monitor to `y = monitor_depth + 4`, and carries the swept cord channel `arm_channel_path()` inside, with fillets at both bends.
  - **Backplate:** at the arm's front end, rotated `tilt` back about X, containing `magnet_seat()` at `ct_magnet_center` and `plug_holder()` on `ct_port_edge`.
  - **Position:** the Car Thing's position follows `ct_corners()`.
- [ ] **Step 3:** Run the test and expect all checks and bed fit to pass. Render a preview PNG with `openscad --render --camera=... -o /tmp/main.png main-mount.scad`. Look at it and confirm the side profile matches the 15° mockup (option A).
- [ ] **Step 4:** Commit: `git commit -am "feat(mount): plate, cord arm and tilted magnet backplate"`

### Task 5: Electronics pocket and main-mount shelf slot

**Files:** Modify `hardware/mount/main-mount.scad` and `hardware/mount/checks.scad`.

- [ ] **Step 1:** Add to `checks.scad`:
  - `assert(plate_h >= 3 * shelf_overhang_y, "plate tall enough to resist peel")`, where `shelf_overhang_y = item_t + slot_clear + wall`;
  - `assert(pocket fits inside plate footprint)`;
  - `assert(pocket outer face open or vent area >= 30%)`.
  Run the test and expect it to fail.
- [ ] **Step 2:** Add the pocket and the slot to the plate:
  - **Pocket:** sized to `pocket`. It's open on its −Y face, with a power-cable exit and a channel joining the arm's cord channel. Put the dongle end at the plate's outer edge.
  - **Slot:** `shelf_slot(slot_len)` on the plate's left, toward the monitor's center. Its cable notch faces down.
- [ ] **Step 3:** Run the test and expect it to pass, including the 240 × 200 footprint. If the slot doesn't fit within the footprint, stop and tell the owner. Don't split the part.
- [ ] **Step 4:** Commit: `git commit -am "feat(mount): electronics pocket and shelf slot"`

### Task 6: Standalone shelf, exports, assembly notes and physical check

**Files:**
- Create: `hardware/mount/standalone-shelf.scad`, `hardware/mount/build.sh`, `hardware/mount/README.md`, and the exports in `hardware/mount/stl/` and `hardware/mount/step/`

**Interfaces:**
- Consumes: `shelf_slot()`, plate parameters.
- Produces: `main-mount.stl`, `standalone-shelf.stl` and `.step` copies of each.

- [ ] **Step 1:** Write `standalone_shelf()`: a plate `slot_len + 2*wall` wide and at least `3 * shelf_overhang_y` tall, plus `shelf_slot(slot_len)`. The test picks it up automatically. Run the test and expect it to pass.
- [ ] **Step 2:** Write `build.sh`. It renders each part to `stl/`, then runs `freecadcmd` with an inline Python script. The script does `Mesh.read` → `Part.Shape.makeShapeFromMesh(tol 0.1)` → `removeSplitter()` → `exportStep`, writing to `step/`. Run it and confirm both STEP files open (re-import them in `freecadcmd` and count faces > 0).
- [ ] **Step 3:** Write `README.md` covering:
  - **Print:** PETG, 4 walls, 40% gyroid, plate face down, no supports under the magnet pocket.
  - **Parts list:** magnet, 1/4-20 nut, USB-C plug breakout, C-to-A adapter, VHB tape.
  - **Assembly order:** nut and magnet; plug wiring per pogo-dock.md; cord through the arm; pocket parts.
  - **Mounting:** stick the main mount on the right half of the back, clear of the stand and vents. Clean the back with isopropyl alcohol, press for 30 s, and wait 24 h before loading.
- [ ] **Step 4:** Print and do the physical check:
  - **Wobble:** press every button and turn the knob. Expect no movement.
  - **Removal:** slide the Car Thing off and on 10 times.
  - **Hang test:** hang 2 × 300 g on the shelf for 48 h. Expect no peel or creep.
  - **Power and Wi-Fi:** the Car Thing boots on the plug and `ip link` shows `wlan0`.
- [ ] **Step 5:** Commit: `git add hardware/mount && git commit -m "feat(mount): standalone shelf, exports and assembly notes"`
