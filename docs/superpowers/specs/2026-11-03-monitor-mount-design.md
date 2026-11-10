# Monitor Mount Design

**Date:** 2026-11-03
**Status:** approved by owner 2026-11-03

## Intent

The panel spec's last milestone is a **stand**: something that holds the Car Thing, its hub and its Wi-Fi adapter at the desk with a single power input. This design replaces the desk stand with a **mount stuck to the back of the owner's monitor**. The Car Thing hangs just below the monitor's bottom edge, out in front, tilted slightly up toward the owner. The hub, dongle and cabling hide behind the monitor.

While designing it, the owner also asked for small shelves on the back of the monitor for two USB devices that live there.

## Goals

- **No wobble.** The owner's words: "I don't want any wobbles. I want it very secure." Pressing buttons, turning the knob and touching the screen must not move the Car Thing.
- **Tool-free removal of the Car Thing.** A magnet holds it in place. It slides off sideways for flashing and recovery and slides back on.
- **USB through a USB-C plug fixed to the mount**, wired as in [docs/hardware/pogo-dock.md](../../hardware/pogo-dock.md).
- **Hidden cabling.** The USB cord runs inside the arm.
- **Room inside for the USB Wi-Fi dongle** (and the powered OTG hub it hangs off; see the panel spec's Networking section).
- **Adhesive only.** Everything sticks to the monitor's back. Use as much adhesive area as possible.
- **One shelf slot on the main mount** for one USB device, plus **a second standalone shelf** for the other.

## Non-goals

- Mounting to VESA, the monitor stand or the desk.
- Holding the Car Thing anywhere other than this monitor.
- A pocket or lip around the Car Thing. The owner rejected it: the magnet is very strong, and the USB plug sitting in the port helps locate it.

## Anti-goals (failure even if it technically works)

- The Car Thing rocks or shifts when used.
- The Car Thing covers any part of the screen from the owner's seat.
- The adhesive slowly peels or creeps, and the mount sags over weeks.
- Visible cable between the monitor and the Car Thing.

## The monitor

- **Kuycon G27P**, a 27" 5K display: 618 × 360 mm (24.3 × 14.2 in), **22 mm deep** (0.87 in), 5.5 kg. Figures are from kuycon.us/monitors/G27P/specs. The owner's own estimate: "about an inch thick to slightly less."
- **The back is entirely flat**, per the owner.
- Bezel sizes aren't published. **Measure the bottom bezel and the back before final dimensions.**

## The main mount (owner decisions)

The parts, from the back of the monitor to the front:

1. **Adhesive plate:** a large flat plate on the back of the monitor, low down. It carries everything else.
2. **Arm:** a small hollow arm. It drops from the plate past the monitor's bottom edge and wraps forward under it with **a slight gap** (Claude's guess: about 4 mm). Then it comes out in front of the screen. **The USB cord runs inside the arm.**
3. **Backplate:** at the front end of the arm. It accepts the **Magnetpro pot magnet**: 1.69 in (43 mm) diameter, 0.24 in (6 mm) thick, with a 1/4"-20 stainless male stud 0.5 in (12.7 mm) long.
4. **Tilt:** the backplate leans **15° back from vertical**, so the screen faces slightly up toward the owner. The owner picked this from mockups of 15°, 25° and 40°.
5. **Car Thing:** its back is magnetic. The owner reports that it "sticks very well" to a magnet, so no steel plate is needed.
   - **USB plug fixed to the mount** (owner decision). A rigid USB-C plug on the backplate goes into the Car Thing's port and locates it alongside the magnet.
   - The Car Thing **slides on and off sideways**, along the plug's axis, rather than lifting straight off the magnet.
   - The plug is a USB-C plug breakout, wired as in pogo-dock.md (VBUS, GND, D+, D−, CC, with its CC resistor removed). The cord in the arm connects it to the charge-through cable. **Claude's reading:** with the plug fixed to the mount, pogo pins aren't needed at this joint.
   - The plug must be backed solidly by the backplate, because it takes sideways loads from the knob and buttons. It must line up with the Car Thing's port exactly when the Car Thing sits flat on the magnet.
6. **Position:** **off to the right side** of the monitor, as seen from the owner's seat. The owner expects the mount's shape not to depend on this. Place the plate wherever the right side of the back is clear of the stand and ports.
7. **Shelf slot:** one slot for a USB device, part of the same adhesive plate (see Shelves).

## Shelves (owner decisions)

- **Two slots, each 4.5 in (114 mm) long.** One is part of the main mount. The other is a **standalone** piece with its own adhesive plate.
- The items are about 3 × 2 in and about 3/4 in (19 mm) thick. They stand upright, leaning against the monitor's back.
- Each slot is just a floor with **a lip along the long side** to keep the item upright. There are no end walls.
- The two items, from photos the owner sent:
  - a **Cable Matters two-port USB-C switch** with an attached USB-C cable. Its ports, button and lights are on one long edge, and the cable leaves the opposite long edge.
  - a **HooToo USB-C hub** with an attached USB-C cable. Its USB-A ports and SD slot are on a long edge, and its HDMI port is on a short end.
- **Which item goes in which slot is open.** The owner didn't say.

## USB parts in the pocket (from photos the owner sent)

- **Wi-Fi adapter:** a TP-Link nano USB-A dongle with a black nub and no antenna, about the size of a thumbnail. **Check the model number:** the UB500 Bluetooth adapter looks the same, and the panel needs the Wi-Fi one (for example, the TX10UB Nano).
- **Charge-through link:** a short flat USB-C cable. The large end is a male USB-C plug with a female USB-C power input on its side. The small end is a male USB-C plug. This replaces the "powered OTG hub" from the panel spec.
- **Wiring (Claude's reading):** the large end feeds the Car Thing (through the pogo link), and the power supply plugs into its side port. The small end goes to the dongle. That needs a **USB-C male to USB-A female adapter**, because the dongle is USB-A.
- The pocket only needs to hold small parts: the splitter head, a C-to-A adapter, the dongle and the coiled flat cable. The builder should measure them.

## Make

- **3D printed in PETG** (owner's choice) on a **Prusa MK4** (250 × 210 × 220 mm build volume).
- **Claude's call:** model in **OpenSCAD**, parametric, with the source in this repo and **STL and STEP** exports. The owner's Downloads folder has STEP and Fusion files, so STEP opens in Fusion.
- **Claude's call:** every part fits within **240 × 200 mm** in the XY plane, leaving a margin on the MK4 bed. The main mount should print as one piece if it fits.

## Claude's calls (owner can override)

- **Magnet retention:** the stud passes through a hole in the backplate and is held by a 1/4-20 nut in a hex pocket. The magnet face is flush with, or sits proud of, the backplate front, with **no plastic over the magnet face**. Plastic between the magnet and the Car Thing weakens the grip quickly.
- **Car Thing position:** its top edge stays **just below the bezel line**. The sight line from the owner's eyes to the bottom of the screen clears it.
- **Plate size:** the plate is as tall as practical. The load sits away from the wall and pulls hardest on the plate's top edge, so height fights peel better than width.
- **Adhesive:** 3M VHB tape (or equivalent) across the whole back face of each plate. The plate is stiff enough not to flex: PETG at 4 mm or more, ribbed if needed.
- **Charge-through link and dongle:** they live in a pocket in the part of the main mount behind the monitor, which keeps the arm and front slim. A single power cable leaves the pocket.
- **Shelf slot sizing:** each slot is about 21 mm deep (19 mm item plus clearance) with a lip about 6–8 mm high. Each has a notch for the attached cable. **Port edges stay clear:** the lip and floor never cover a port, and there's room for plugs that stick out.
- **The 15° tilt** is a parameter, so it can be changed and reprinted. It's measured from the screen's plane, so it stays right if the monitor itself is tilted.
- **Dongle signal:** the G27P's back may be metal, so the hub and dongle pocket is open on its outer face (or vented), and the dongle sits at the outer edge, away from the monitor.

## Left to the builder

- **Measure the Car Thing:** size, the position of its USB-C port, and where the magnet sits best on its back.
- **Measure the desk clearance:** the height from the monitor's bottom edge to the desk. Check the Car Thing fits below the edge, and that it clears the sight line from the owner's seat.
- **Check the back's finish** before choosing the adhesive. VHB bonds poorly to textured or coated plastic.
- **Plug mounting and wiring path.** Follow pogo-dock.md for the pinout. Find which edge of the Car Thing the port is on, because that sets the slide direction.
- **Split into printable parts and decide how they join.** One print is best if it fits, because a joint is a wobble risk.
- Print orientation, wall counts and infill for stiffness.
- The exact arm cross-section and cord channel size. It must pass the cord chosen for the hub-to-pogo link.
- Where the power cable and the switch and hub cables exit.
