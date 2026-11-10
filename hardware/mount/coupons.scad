// Small test prints that check the fits before the full parts are printed.
//   magnet: a backplate section with the magnet seat
//   slot:   a short shelf slot, its opening long enough for one plug, on a
//           plate stub
//   socket: a block of the pocket's base with the rod's socket, and a stub
//           of the rod's top end, to check the glue fit and the key
// (The dock and the rod are small prints of their own: try the dock on the
// Car Thing, and thread the wires through the rod, before gluing.)
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

part = "magnet";

// The slot stands on one end, as the standalone shelf prints: as owned, x runs
// from -len to 0, and turned up the x = 0 end sits on the bed.
module slot_coupon() {
  len = 2 * floor_end + 26;
  translate([0, 0, -floor_t - slot_depth()]) cube([len, plate_t, lip_h + 5 + floor_t + slot_depth()]);
  shelf_slot(len);
}
if (part == "slot") rotate([0, 90, 0]) as_owner() slot_coupon();

as_owner() if (part == "magnet") {
  bt = backplate_thickness();
  difference() {
    translate([-(magnet_d + 12) / 2, -(magnet_d + 12) / 2, -bt]) cube([magnet_d + 12, magnet_d + 12, bt]);
    magnet_seat();
  }
} else if (part == "socket") {
  // The block prints as the plate does, bore opening on the bed; the stub
  // stands on its cut end beside it.
  w = rod_d / 2 + 6;
  difference() {
    intersection() {
      union() {
        soft_slab([0, plate_w], [0, plate_h], plate_t, plate_r, soft_r);
        pocket_positive();
      }
      translate([rod_x() - w, -plate_t - pocket[1] - 1, 0]) cube([2 * w, pocket[1] + plate_t + 1, socket_depth + socket_cone_h() + 3]);
    }
    socket_negative();
    cord_channel();
  }
  translate([2 * w + 10, 0, 6]) difference() {
    intersection() {
      rod_solid();
      translate([rod_x() - rod_d, rod_y() - rod_d, -6]) cube([2 * rod_d, 2 * rod_d, socket_depth + 6]);
    }
    cord_channel();
  }
}
