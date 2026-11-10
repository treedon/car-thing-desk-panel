// The main mount, as three prints glued together (lib/joint.scad): the
// plate behind the monitor with the pocket and shelf, the rod, and the
// hidden dock behind the Car Thing.
//   part = "plate", "rod", "dock": a printable part, lying as it prints
//   part = "leak":    the cord channel outside the parts' solid envelope or
//                     inside the magnet seat; empty when it's sound
//   part = "clash":   where the item, standing in the shelf slot with its
//                     plugs, meets the mount; empty when it fits
//   part = "collide": where the parts, assembled, overlap; empty when the
//                     keys line up and the glue gaps are open
//   part = "channel": part material inside the cord channel; empty when
//                     every part clears it
// (test/mount.test.sh renders each test part and expects it empty.)
include <params.scad>
include <lib/geometry.scad>
include <lib/path.scad>
include <lib/magnet.scad>
include <lib/shelf.scad>
include <lib/dock.scad>
include <lib/pocket.scad>
include <lib/rod.scad>
include <lib/joint.scad>
include <lib/soft.scad>

part = "plate";
leak_margin = 0;  // the leak render grows the channel by this much

module plate() {
  soft_slab([0, plate_w], [0, plate_h], plate_t, plate_r, soft_r);
  plate_ribs();
}

// The parts in place, in the mount's coordinates.
// Cut flat at the plate's bottom edge, which is its bed: the pocket's and the
// shelf's bases run past it so the cut leaves one clean face.
module plate_part() {
  difference() {
    intersection() {
      union() {
        plate();
        pocket_positive();
        translate([shelf_x0(), -plate_t, shelf_z]) shelf_slot(slot_len);
      }
      translate([-1, -plate_t - pocket[1] - 10, 0]) cube([plate_w + 2, pocket[1] + plate_t + 20, plate_h + 1]);
    }
    pocket_negative();
    socket_negative();
    cord_channel();
  }
}

module rod_part() { difference() { rod_solid(); cord_channel(); } }

module dock_part() { difference() { ct_place() dock_local(); cord_channel(); } }

module mount_solid() {
  plate_part();
  rod_part();
  dock_part();
}

// The parts' solids without their holes, for the leak test.
module mount_envelope() {
  plate();
  pocket_positive();
  rod_solid();
  ct_place() { dock_plate(); dock_block(); }
}

if (part == "plate") {
  as_owner() plate_part();
} else if (part == "rod") {
  // Standing as mounted, its flange's lowest edge on the bed.
  as_owner() translate([0, 0, -rod_low_z()]) rod_part();
} else if (part == "dock") {
  // Back in its own frame, then lying on its back.
  as_owner() translate([0, 0, backplate_thickness()]) rotate([90, 0, 0]) ct_unplace() dock_part();
} else if (part == "leak") {
  difference() {
    cord_channel(leak_margin);
    mount_envelope();
  }
  // The channel must not open into the magnet's seat either.
  intersection() {
    cord_channel(leak_margin);
    ct_place() translate([ct_magnet_center[0], 0, -ct_magnet_center[1]]) rotate([-90, 0, 0]) magnet_seat();
  }
} else if (part == "clash") {
  intersection() {
    mount_solid();
    translate([shelf_x0(), -plate_t, shelf_z]) shelf_item(slot_len);
  }
} else if (part == "collide") {
  intersection() { plate_part(); rod_part(); }
  intersection() { rod_part(); dock_part(); }
  intersection() { plate_part(); dock_part(); }
} else if (part == "channel") {
  intersection() { mount_solid(); cord_channel(-0.2); }
} else {
  assert(false, str("unknown part: ", part));
}
