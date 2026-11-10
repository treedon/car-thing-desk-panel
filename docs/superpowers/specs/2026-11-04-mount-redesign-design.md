# Monitor Mount Redesign

**Date:** 2026-11-04
**Status:** draft, awaiting owner approval
**Builds on:** [2026-11-03-monitor-mount-design.md](2026-11-03-monitor-mount-design.md). Everything there still holds unless this document changes it.

## Intent

The first mount works, but the owner's verdict on it was: "these 3d parts are hideous … very blocky, i could have made this out of lego bricks. the carthing is beautiful hardware and the mount should be as well."

This redesign is about how the mount **looks**. The mount should be "minimal and barely seen". In the owner's words: "i'd rather the arm post be the only bit visible other than the car thing." Every shape should be "rounded".

It also corrects the Car Thing facts. The first design guessed the USB-C port was on the bottom edge. In fact the port is on the **back**, which is what makes a hidden mount possible.

## Goals

- **From the owner's seat, only two things show:** the Car Thing and one round post. The backplate, magnet, plug and cord sit inside the Car Thing's outline or behind the monitor.
- **The post (owner decisions):**
  - a **round rod, 16 mm in diameter**, with a **single bend**. It runs straight down behind the monitor, bends once under the bottom edge, then runs straight forward to the Car Thing.
  - **centred** behind the Car Thing.
  - The owner chose this from rendered mockups, first at 10 mm and then at 16 mm.
- **No flex when pressing buttons.** In the owner's words: "this is a panel with small buttons i'll need to press and that will cause it to flex. i dont want to have to brace the device to press the button." Thicker was the owner's preference.
- **Rounded everywhere:**
  - no flat-faced boxes or sharp edges on any visible part;
  - the hidden parts behind the monitor get softened too: rounded corners and filleted joints;
  - the owner's attention is on the visible parts.
- Every function from the first design stays:
  - the magnet holds the Car Thing and it slides off sideways;
  - a fixed USB-C plug;
  - the cord hidden inside the arm;
  - the dongle and charge-through cable in a pocket;
  - adhesive only;
  - one shelf slot on the main mount plus the standalone shelf;
  - 15° tilt;
  - right side of the monitor;
  - PETG on the MK4;
  - OpenSCAD with STL and STEP exports.

## Non-goals

- Changing the shelves' or the pocket's function or size.
- A visible cradle, lip or frame around the Car Thing.

## Anti-goals

- **Anything blocky or rectangular that shows from the seat.** That is the failure that triggered this redesign.
- **A post that flexes or twists** when a top button is pressed or the knob is turned.
- Any edge of the backplate showing around the Car Thing from the seat.
- A thin, fragile-looking post. The owner wanted it thicker, not thinner.

## The Car Thing's back (from the owner's photos)

The owner photographed the back on a centimetre grid. The figures below are read off those photos and are approximate. Measure them before final dimensions.

- **Body:** about **120 × 64 mm**, about 20 mm thick. iFixit gives 124 × 64 × 20 mm, including the dial. The dial is on the top edge at one end and sticks out slightly past that end.
- The back has three zones across its width.
  - **Big raised pad,** at the end opposite the dial. It is a rounded rectangle about **46 mm wide** and nearly the full height.
    - **The steel is here.** The owner says a magnet grabs hardest on the big pad.
  - **Recessed middle,** about 45 mm wide, with the regulatory label on it. It runs the full height.
  - **Narrow raised pad** at the dial end, about 22 mm wide.
- **The USB-C port is on the inner edge of the big pad,** facing into the recess toward the dial end. The owner confirmed this.
  - The port is roughly mid-height.
  - The plug goes in sideways, parallel to the back.
- A **small tab** sticks out past the outer end of the big pad, about mid-height. Its purpose is unknown. The mount must not cover it or press on it.

## How the Car Thing is held

- **Magnet:**
  - The 43 mm Magnetpro pot magnet sits **centred on the big pad**. The owner noted it "centers on it perfectly".
  - Its face sits flush with the backplate's front, with no plastic over it, as in the first design.
- **USB-C plug:**
  - It sits **in the recess**, fixed to the backplate.
  - It points at the port, along the Car Thing's width, toward the big pad.
  - It is backed solidly by the backplate behind it and by the block holding it.
- **Docking:**
  - Place the Car Thing on the magnet a few millimetres toward the big-pad end.
  - Slide it toward the dial end until the plug seats.
  - The magnet holds it flat throughout.
  - **To remove it** (my call):
    - Slide it toward the big-pad end, only as far as the plug's travel, to unplug it.
    - Then tip the dial end away from the backplate and lift it off. The magnet lets go easily once it's levered.
    - A full sideways slide-off, as in the first design, isn't possible. The plug block sits in the recess, and the narrow pad would hit it.
  - **The plug block** is narrower than the recess by at least the plug's travel plus clearance, so the unplug slide is free.
  - **The slide must end on a hard stop when the plug is fully seated,** so the plug isn't what stops the travel. My call: the recess wall or the end of the big pad does this.
- **No twist, no rock:**
  - The block holding the plug fills the recess closely enough that the recess walls stop the Car Thing rotating on the magnet.
  - The backplate's front also bears on both pads, so the Car Thing can't rock about the magnet.

## The backplate (hidden)

- **Hidden from the seat.**
  - Its outline is inside the Car Thing's back, seen straight on, with margin all round, so no edge shows from the owner's seat.
  - It stays clear of the dial and the small tab.
- **Slim.**
  - It is visible from the side, so keep it as thin as the magnet allows and round all its edges.
  - **The first design's backplate was about 19 mm thick,** because the magnet's 12.7 mm stud stayed whole inside it. This design should do better, for example by cutting the stud short or finding another way to retain the magnet.
  - **Target:** no thicker than the post (16 mm), and thinner if possible. This is my call.
- **Shape:**
  - Its front fits the back of the Car Thing: flat against both pads, with a plug block reaching into the recess.
  - Its back is a soft, rounded form that the post flows into.

## Owner decisions during the build (2026-11-04)

- **The rod is 22 mm, one even thickness throughout.**
  - At 16 mm, thickening only the hidden parts reached about 0.13 mm. The owner first chose an 18 mm visible rod with a 24 mm hidden part.
  - The final review then found the stiffness estimate had measured the lever to the backplate rather than to the buttons. Corrected, 18/24 gives about 0.13 mm.
  - The review also found that a seated eye more than about 180 mm above the screen's bottom edge sees the bend, so a rod that thickens only where hidden would show a step.
  - The owner chose an even 22 mm rod: about 0.096 mm, and the same look from any seat height.
  - The Car Thing's reach in front of the screen was also cut by 4 mm.
- **The top buttons must stay reachable.** The owner rejected pulling the Car Thing back under the monitor, which would have stiffened the rod further, because a fingertip pressing the top buttons must clear the monitor. This is now a rule: a 16 mm fingertip on the middle of the top edge clears the screen face by 2 mm.
- Where the text below says 16 mm for the rod, read **22 mm**.

## The post (visible)

- **Section:** round, **16 mm diameter**, the same along its whole visible length.
  - Where it meets the backplate, it widens in a smooth fillet so the joint is stiff. This is my call.
  - Where it meets the plate behind the monitor, it is filleted into the plate.
- **Path: one bend, as in the mockup the owner approved.**
  - The rod runs straight down the monitor's back from the plate. It carries on **below the monitor's bottom edge** to about the Car Thing's mid-height.
  - There it makes its **one** bend, behind the Car Thing.
  - It then runs straight forward into the centre of the backplate's back. Its axis meets the backplate at the centre of the Car Thing, both sideways and up and down.
- **What shows:** from the seat, the only visible part of the mount is the short vertical stretch of rod in the gap between the bezel and the Car Thing's top edge. The bend and the forward run sit behind the Car Thing.
- **Car Thing position:** its top edge stays just below the bezel line, as in the first design.
  - The first design's "arm passes 4 mm under the bottom edge" no longer applies, because nothing runs forward under the monitor.
  - Instead, the vertical rod sits behind the monitor's back face, clear of it by enough that the adhesive plate fillet blends into it.
- **Bend radius:** the builder's choice, within the cord's bend limit.
- **Inside:** the cord channel runs through the centre of the rod, from the pocket to the plug block.
- **Stiffness:**
  - A firm press (about 5 N) on the end button of the top row should move the Car Thing by no more than about **0.1 mm** at that button, from the rod bending and twisting combined. My rough estimate for a 16 mm PETG rod over this reach is about 0.1 mm.
  - The rod's joints to the plate and to the backplate must not be the weak link.
  - **If the target isn't met** (my call):
    - Thicken the hidden parts first: the vertical run behind the monitor, the bend, and the fillets.
    - Keep the visible rod at 16 mm.
    - Keep it all PETG, with no metal core.

## Behind the monitor (hidden, carried over)

- **Unchanged:** the adhesive plate, the pocket for the dongle and charge-through cable, and the shelf slot, as in the first design.
- **Softened:**
  - rounded plate corners;
  - filleted joints where the slot and pocket meet the plate;
  - the post blended into the plate rather than a rectangular arm.
- **The standalone shelf** gets the same softening.

## Shelves, revised (2026-11-05)

- **The problem (owner):** items tilt out of the slots and could fall. The monitor tilts back, so its back faces slightly down and the items always lean out onto the lip.
- **Owner decisions:**
  - Items stand **ports-down**, with plugs in their ports (all three USB-A ports on the hub are in use). They're rarely plugged or unplugged.
  - Fix it with a taller lip, not a lip over the top.
- **The slot now:**
  - a 35 mm lip, past the 51 mm item's middle, with its top third clear to grab;
  - the floor open down the middle for the plugs, with the item resting on a 4 mm ledge each side;
  - the floor solid for 12 mm at each end, tying the lip to the plate.
- **Claude's calls:**
  - **Cable notch:** dropped. A guess: each item's own cable leaves from its top edge or an end, so only plugs come out of its bottom edge.
  - **Shelf height:** each slot sits high enough for the plugs to end above its plate's bottom edge. The plug length (`item_plug_drop`, 40 mm) and thickness (`item_plug_t`, 10 mm) are guesses until measured.
  - **Main mount:** the plate can't grow (it's 191 mm tall printed upright, against the MK4's 210), so the shelf moves up within it. The rib behind the shelf is dropped. The other three start just above the pocket.
  - **Standalone shelf:** the plate is now as wide as the slot, so the slot's end prints flat on the bed.

## Back shape, corrected (2026-11-06)

The sections above describe the Car Thing's back inverted. The owner confirmed the real shape:
- **One raised flat platform** in the middle, 46 mm long and 5–6 mm proud, with the steel the magnet grips. Its ends curve down to the thin ends.
- **Thin ends:** 46 mm at the tab end (left from the front) and 24 mm at the dial end.
- **The USB-C port** is in the platform's end wall, facing the tab end.
- **The dial** is on the front face at the dial end, not the top edge.

What changed in the dock:
- **Magnet:** it sits centred on the platform.
- **Plug block:** it sits over the thin tab end, its plug pointing at the port.
- **Docking:** place the Car Thing 6 mm toward the dial, then slide it toward the tab end to plug in. Slide it toward the dial to unplug.
- **Rod:** it meets the dock behind the plug board, 41 mm from the tab end (`joint_x`), not at the centre. A centred rod's peg hole would hit the magnet's nut, and the wires couldn't get past the magnet in the dock's 14 mm.
- **Stiffness:** to keep the owner's even 22 mm rod, the press limit rises from 0.1 to 0.14 mm. The estimate is 0.13 mm. The end buttons' positions (`ct_end_buttons`) are a guess.

## Claude's calls (owner can override)

- **Colour:** matte black PETG, so the post reads as a shadow next to the Car Thing.
- **Backplate thickness:** a target of 16 mm or less.
- **Stiffness:** the 0.1 mm stiffness target.
- **Fillet** where the post meets the backplate.
- **A hard stop** at full insertion.
- **The first design's plug ledge is gone,** because the bottom port it served doesn't exist.
- **Removal:** unplug-slide, then tip it off (see How the Car Thing is held).
- **Seat position for the visibility check:**
  - The owner sits centred on the monitor's width.
  - The mount sits at a parameter `mount_x`, on the right half. The default is the Car Thing centred 150 mm right of the monitor's centre.
  - The backplate's inset inside the Car Thing's outline must keep it hidden from that eye point.

## Left to the builder

- **Measure the Car Thing's back.** The redesign depends on these, so print fit coupons before the full part.
  - **The three zones:** each one's width and how much it stands proud, in particular **how deep the recess is**.
  - **The port's position:** height from the top edge, depth from the pad surface, and the travel needed to seat the plug.
  - **The small tab:** its size.
  - **The dial:** how far it overhangs the body.
  - **The corner radii.**
- **Choose the magnet retention** that makes the backplate thinnest.
- **Pick the bend radius and print orientation.**
  - Printing on its side, as before, keeps the bend within each layer.
  - Hide any support marks or flattened faces needed for printing on surfaces that can't be seen from the seat: the post's underside, the side facing the monitor, the backplate's back.
- **Update the checks and tests.**
  - Remove the ledge and port-edge cases.
  - Add checks that the backplate stays inside the Car Thing's outline seen straight on.
  - Add a check that the post is the only part visible from the eye point (`eye` in `params.scad`).
