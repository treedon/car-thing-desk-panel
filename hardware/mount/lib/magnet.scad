// The pot magnet's seat: a pocket open at the face, a through-hole for the
// stud, and a hex pocket from the back for the nut on the stud's end.
// Negative volume. Face plane at z = 0, magnet face pointing +Z.

function magnet_pocket_depth() = magnet_t;
// The length to cut the stud to, so it ends just inside the backplate's back.
function stud_cut() = backplate_thickness() - magnet_t - 0.2;

module magnet_seat() {
  bt = backplate_thickness();
  translate([0, 0, -magnet_pocket_depth()]) cylinder(d = magnet_d + fit, h = magnet_pocket_depth() + 1);
  translate([0, 0, -bt - 1]) cylinder(d = stud_d + fit, h = bt + 2, $fn = 24);
  translate([0, 0, -bt - 1]) cylinder(d = (nut_af + fit) / cos(30), h = nut_t + 0.4 + 1, $fn = 6);
}
