// The pocket behind the plate for the charge-through cable, the C-to-A
// adapter and the Wi-Fi dongle, and where the shelf slot sits beside it.
// The pocket's outer face is open inside a retaining frame, in case the
// monitor's back is metal; put the dongle at that open face.

function shelf_x0() = plate_r;  // clear of the plate's rounded corner
// The plate's vertical ribs: each one's left edge. One at the plate's left
// edge, beside the shelf, and two over the pocket; the shelf's tall lip
// stiffens the stretch between.
function rib_xs() = [wall, 2 * plate_w / 3, plate_w - wall - rib_w];
function pocket_x0() = plate_w - pocket[0] - wall;

module pocket_positive() {
  // Rounded on every edge; its plate side sinks into the plate. Solid from
  // the plate's bottom edge up to the pocket's floor: the rod's socket is
  // bored up into that base. It starts below
  // the bottom edge and the plate is cut flat there (plate_part()).
  soft_box([pocket_x0() - wall, pocket_x0() + pocket[0] + wall],
           [-plate_t - pocket[1], -plate_t + 1],
           [-soft_r - 1, pocket_z0 + pocket[2] + wall], soft_r);
}

module pocket_negative() {
  // The cavity.
  translate([pocket_x0(), -plate_t - pocket[1] + wall, pocket_z0])
    cube([pocket[0], pocket[1] - wall + 0.01, pocket[2]]);
  // The open outer face, inside the frame.
  translate([pocket_x0() + pocket_frame - wall, -plate_t - pocket[1] - 1, pocket_z0 + pocket_frame - wall])
    cube([pocket[0] - 2 * pocket_frame + 2 * wall, wall + 2, pocket[2] - 2 * pocket_frame + 2 * wall]);
  // The power cable's exit: a notch down from the top of the side wall
  // toward the monitor's edge, open at the top so the cable lays in, and
  // It cuts the wall only.
  translate([pocket_x0() + pocket[0], -plate_t - pocket[1] / 2 - 4, pocket_z0 + pocket[2] / 2])
    cube([wall + 1, 8, pocket[2] / 2 + wall + 1]);
}

// The plate's vertical ribs, on its back, each with its lower end sloping
// back into the plate so it doesn't start in mid-air.
module plate_ribs() {
  for (x = rib_xs())
    translate([0, -plate_t + 0.5, 0]) hull() {
      soft_box([x, x + rib_w], [-5.5, 0], [rib_z0 + 6.5, plate_h - plate_r], 1.4);
      translate([x, -0.5, rib_z0]) cube([rib_w, 0.5, plate_h - plate_r - rib_z0 - 1.4]);
    }
}
