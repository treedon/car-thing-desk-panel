# Monitor Mount in Three Prints

**Date:** 2026-11-05
**Status:** draft, awaiting owner approval
**Builds on:** [2026-11-04-mount-redesign-design.md](2026-11-04-mount-redesign-design.md), including its "Shelves, revised (2026-11-05)" section. Everything there still holds unless this document changes it. In particular, the mount looks the same from the owner's seat.

## Intent

Today the main mount is one print: the adhesive plate, pocket, shelf, rod and the hidden dock behind the Car Thing. It prints upright, dock end down, so the visible rod comes out as clean round layers. But that leaves the plate's bottom edge, the pocket and the shelf floating 55–95 mm above the bed, on large supports.

The owner wants the parts printed separately and joined after printing. In the owner's words, the prints must not be "relying on massive supports", and the joined mount must be "rigid and sturdy".

## Goals

- **Three prints, glued at two joints:**
  - the **plate**: the adhesive plate, the pocket, the shelf;
  - the **rod**: the visible rod with its one bend;
  - the **dock**: the hidden piece behind the Car Thing, with the magnet and the plug.
- **Each print needs no support taller than 3 mm.** Bridges are fine if they're anchored at both ends and span 35 mm or less.
- **Rigid and sturdy.** Glued, the mount must hold the existing stiffness target: a 5 N press on the end button moves the Car Thing 0.1 mm or less.
- **The visible rod still prints upright,** as round layers with nothing touching it.
- **The joints are hidden.** One sits behind the monitor, the other behind the Car Thing.
- **The parts fit together one way only.** Each joint is keyed, so the rod can't be glued in rotated.

## Owner decisions (2026-11-05)

- Split the mount into parts that are joined after printing.
- **Glue is fine.** The joints don't need to come apart.
- **Split at the dock** (Claude's recommendation, taken by the owner). Avoiding big supports then needed a third part, the rod on its own. The owner accepted that, "as long as it's rigid and sturdy".
- **The Car Thing's back is curved.** The magnetic pad's flat top is about the size of the 43 mm magnet, and its edges curve down to the body. The owner is fine with the dock's flat face standing off where the back curves away. Nothing changes: the magnet already sits on the flat part, centred, and the dock stays 4 mm inside the Car Thing's outline.

## Non-goals

- Changing how the mount looks from the seat, where the Car Thing sits, or the rod's size and path.
- Joints that come apart.
- Changing the standalone shelf. It already prints on its end with no supports.

## Anti-goals

- **Any wobble at a joint.** It would show as the Car Thing moving when a button is pressed.
- **A visible joint line, seam or glue** on the rod below the monitor.
- **Large supports on any print.** In particular, nothing that needs a support wall under a long edge or a floor.
- **Supports touching the visible rod.**

## The plate

It holds everything that sits behind the monitor: the adhesive plate, the pocket with its open face and cable slot, the ribs, and the shelf.

- **It prints upright,** standing on its bottom edge, the edge that sits on the monitor's bottom edge. That's the same orientation as mounted.
- To print without supports, nothing may overhang the air below it. So everything that rests on the plate's bottom edge goes all the way down to it.
- **The pocket's base:** the pocket sits on a solid base that runs down to the plate's bottom edge.
  - The rod's socket is bored up into this base from below. It opens on the plate's bottom edge.
  - The pocket moves up by the socket's depth plus a few millimetres, to about 30 mm instead of 8 mm.
  - The ribs over the pocket still start just above it.
- **The rod's socket:**
  - **Depth:** at least the rod's diameter, so 22 mm or more.
  - **Fit:** the rod's top end slides in with `fit` clearance for the glue.
  - **Key:** a flat on the side toward the monitor (a D shape), so the rod goes in one way.
  - **Top:** narrows in a steep cone to the cord channel, which carries on up into the pocket. The cone needs no support.
- **The shelf's base:**
  - The main-mount shelf becomes a solid base from the plate's bottom edge up to the floor. The plug opening runs through it from top to bottom, and the 35 mm lip rises from its outer side.
  - The item stands on the base's top, with its plugs down the opening. The cables leave through the open bottom.
  - Its outer face continues as the lip, which makes a front wall from the plate's bottom edge to the lip's top.
  - The clash test still applies: the item and its plugs touch nothing.
- **The ribs:**
  - the same three as now, starting above the pocket;
  - their lower ends angled at 45°, so none starts in mid-air.
- **The pocket's bridges:**
  - **Ceiling:** about 28 mm, from the plate to the frame on the open face.
  - **Top of the open face:** about 57 mm wide today. A centre post splits it into two bridges of about 25 mm. The face must stay at least 30% open for Wi-Fi.
  - **Power-cable slot:** it becomes a notch down from the top of the side wall. The old slot opened to the outer face, so its roof hung from one end. The cable still lays in, now from above.

## The rod

- **Shape:** the same rod as now: 22 mm, straight down, one bend, straight forward.
  - **Top end:** cut off at the socket's depth above the plate's bottom edge, with the D flat that matches the socket.
  - **Front end:** a flange that sits flat on the dock's back.
- **It prints standing on its forward run**, in the same orientation as mounted. The visible vertical run goes straight up and prints as round layers.
- **What gets added so it stands on the bed,** all of it hidden behind the Car Thing:
  - **A keel under the forward run:** its sides are tangent to the run at 50° and slope at 50° down to a narrow flat foot on the bed. That's steep enough to print, and it covers every part of the run flatter than 45°. It adds material rather than cutting the run, so the forward run keeps its full stiffness and the stiffness model needs no change.
  - **Under the bend's outer curve:** filled with a wedge, its back sloping at 50°, down to the same bed plane, so the bend needs no support.
  - **The flange:** cut flat by that bed plane, so it stands on the bed.
- **The flange:**
  - a disc about 36–40 mm across;
  - centred on the rod's axis where it meets the dock's back;
  - lying in the dock's back plane, which is tilted 15° from the forward run;
  - glued flat against the dock's back.
- **A spigot** sticks out of the flange into a hole in the dock:
  - 12 mm across and 6 mm long, since the dock is only 14 mm thick;
  - its axis square to the dock's back;
  - teardrop-shaped, with the point down.
  - The teardrop keys the joint and prints without support, even though its axis tilts.
- The cord channel runs through the rod's whole length, out through the spigot and on into the dock.

## The dock

- **The same dock as now,** with the rod's flare removed.
- **Additions:**
  - a teardrop hole in its back for the spigot;
  - the cord channel, running from the bottom of that hole to the plug board.
- **It prints flat on its back.**
  - The magnet pocket and the plug block face up.
  - The only bed-level hole that needs bridging is the nut pocket's top, about 11 mm across. That's within the "bridges over small holes" allowance.
  - The spigot hole has a flat top, a bridge over a small hole. A cone doesn't fit the dock's 14 mm. That's why the spigot is 12 mm: its teardrop hole stays under the 15 mm small-hole limit. A short cord channel runs on to the board pocket.
  - **The board pocket's roof:** 1 mm thick, bridging about 16 mm. The plug's slot through the shoulder breaks one end of it. The slot has to reach the block's open bottom so the board can slide in, and the block can't be any deeper than the recess. The support check accepts this one region, which the dock's render names. It's internal, and it gets potted.
- **The flange's outline must stay hidden from the seat,** like the dock's outline.

## The joints

| Joint | Where | Glue area | Key |
|---|---|---|---|
| Rod top to plate | inside the pocket's base, behind the monitor | 22 mm rod, at least 22 mm deep | a flat facing the monitor |
| Rod to dock | on the dock's back, behind the Car Thing | a 38 mm flange plus a 12 × 6 mm spigot | the teardrop spigot |

- **Glue:** a two-part epoxy for plastics. Scuff both faces first, dry-fit, then glue. Let it cure 24 h before loading.
- **Keep the cord channel clear:** no glue on the spigot's end or in the socket's cone.
- **The stiffness model treats both joints as rigid.** It already fixes the vertical run at the plate's bottom edge, and treats the dock as rigid past the forward run's end. Both joints sit exactly at those places.

## Checking for supports

The owner's rule, "no massive supports", becomes an automated test.

- **Each part is exported in its print orientation,** so its STL drops straight into the slicer.
- **A new script checks each part's STL.** It finds every downward-facing surface that's flatter than 45° and more than 3 mm above the bed, then looks straight down from it:
  - **If it reaches the bed,** the slicer would build a support there, which fails the test. The exception is a bridge over a small hole: one with the part on every side within 15 mm.
  - **If it hits the part,** it's a bridge. It passes only if it's anchored on two opposite sides within 35 mm.
  - The script reports the tallest support and the longest bridge it found.
- **It runs in `test/mount.test.sh`** on the plate, rod, dock and standalone shelf.
- **It has small test shapes of its own,** in `test/fixtures/`, to show it can fail:
  - a slab floating above the bed on a post: fails;
  - a 45° chamfer: passes;
  - a bridge over a 10 mm hole: passes;
  - a 50 mm bridge: fails.

## Assembly order

1. **Dock:**
   - Fit the magnet and nut.
   - Try the dock alone on the Car Thing: block clear of the recess floor, slides to unplug, and the magnet holds.
2. **Wires:**
   - Thread the five wires through the rod, from its top end out through the spigot. The rod is loose, so this is easy.
   - Feed them through the dock's spigot hole into the board pocket.
   - Solder them to the plug board, slide the board in, and check continuity.
3. **Rod to dock:**
   - Glue the flange and spigot, keeping the wires inside, and let it cure.
   - Then pot the board. The spigot now plugs the channel, so the potting can't run out through it.
4. **Rod to plate:**
   - Feed the wires' top ends up through the socket into the pocket.
   - Glue the rod's top into the socket, and let it cure 24 h.
5. **Pocket and mounting:** solder the female breakout in the pocket, then mount as before.

## Tests that change

- **Exports:**
  - New: `stl/plate.stl`, `stl/rod.stl`, `stl/dock.stl`, and STEP files for each.
  - Replaced: `main-mount.stl` and `main-mount.step`.
  - **Every part:** renders, is one closed solid, fits the MK4, and passes the support check.
- **Kept, run on the three parts in their mounted positions:**
  - the leak test, at least 1.2 mm of wall around the cord channel;
  - the visibility checks;
  - the stiffness check;
  - the clash test.
- **New rules:**
  - the socket is at least as deep as the rod's diameter;
  - the flange is at least 12 mm wider than the rod;
  - the flange is hidden from the seat;
  - the support check fails its bad test shapes and passes its good ones.
- **Coupons:**
  - **`dock`** is retired: the dock is now a small print of its own, tried on the Car Thing before gluing.
  - **`rod`** is retired: the whole rod is a small print, and the wires are threaded through it before gluing.
  - **New `socket`:** a short block with the plate's socket, plus a short rod-top stub, to check the glue fit before printing the plate.
  - **`magnet` and `slot` stay.**

## Claude's calls (owner can override)

- **Third part:** the rod prints on its own, so no print needs big supports.
- **Joint shapes:** a socket into the pocket's base at the plate, and a flange with a spigot at the dock.
- **Keys:** a D flat at the plate, and a teardrop spigot at the dock.
- **Solid bases:** the pocket and the shelf rest on bases that run down to the plate's bottom edge, instead of on supports.
- **Flattening:** the rod's hidden underside is cut flat and given a 45° wedge, so the rod stands on the bed.
- **The support rule:**
  - surfaces flatter than 45° may not need build-plate support taller than 3 mm;
  - bridges over holes up to 15 mm are fine;
  - other bridges must be anchored on two opposite sides within 35 mm.
- **Rod keel:** a keel added under the hidden forward run, instead of cutting it flat, so it keeps its stiffness. Its sides are at 50°, not 45°, so they cover the run's facets near 45°.
- **Spigot:** 12 mm, with a flat-topped hole.
- **Power cable:** it leaves through a notch open at the top.
- **Dock's board pocket:** the support check accepts its roof, the one bridge open at one end.
- **The pocket's open face:** split by a centre post into two shorter bridges.
- **Assembly:** the rod is glued to the dock before the board is potted.
- **Exports:** parts are exported already in their print orientation.
- **Glue:** a two-part plastic epoxy.

## Left to the builder

- **Exact joint dimensions:**
  - **socket:** depth (at least 22 mm), the D flat's depth (about 2 mm), and the cone angle (steeper than 45°);
  - **flange:** its diameter (36–40 mm) and thickness;
  - **spigot:** its size and the teardrop's angle.
- **Exact pocket height:** the new `pocket_z0`, as long as the socket and its cone fit below the pocket floor.
- **The support script's internals,** as long as it applies the rule above. Pure Python 3 with no extra packages, since numpy isn't installed.
- **Print notes in the README:**
  - each part's orientation;
  - the slicer seam on the rod's hidden back side;
  - brims.

## Supports, revised (2026-11-06)

The owner prefers slicer supports to built-in support shapes. Removed:
- the rod's keel and the wedge under its bend, and the bed cut that flattened the flange (the flange is a full circle again);
- the solid base under the main shelf's floor;
- the post splitting the pocket's open face;
- `test/supports.py` and its test shapes.

Kept, because a slicer support couldn't be removed from inside a closed shape: the cord channel's peaked roof and the socket's cone. Also kept: the ribs' 45° lower ends and the plug opening's chamfered corners, which avoid a tall support tower for a few millimetres of ledge.
