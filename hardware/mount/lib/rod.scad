// The rod: the one visible part of the mount, and its own print. Its top end
// glues up into a socket under the pocket (joint.scad); it runs straight down
// the plate's back, on past the monitor's bottom edge, bends once behind the
// Car Thing, and runs straight forward to a flange glued to the centre of the
// dock's back. The cord runs inside it, from the pocket to the plug's board.

// Centred on the pocket, and the Car Thing centred on the rod.
function rod_x() = pocket_x0() + pocket[0] / 2;
// The vertical run sits against the plate's back, 1 mm into its line; inside
// the socket its D flat clears the plate.
function rod_y() = -plate_t - rod_d_hidden / 2 + 1;
// Where the forward run meets the dock's back: the Car Thing's centre.
function rod_entry() = ct_to_global(joint_centre());
// The cord channel's top, just inside the pocket's floor.
function cord_z_top() = pocket_z0 + 1;

// The rod prints standing as mounted; its lowest point is the flange's
// bottom edge, on the face toward the rod. The slicer supports the hidden
// underside of the bend, the forward run and the flange.
function rod_low_z() =
  ct_to_global(joint_centre())[2] - (fit / 2 + flange_t) * sin(tilt) - flange_d / 2 * cos(tilt);

// The highest z on the vertical run below which the rod, at rod_d_hidden, is
// hidden from the seat: its front and both sides, at every z down to the bend.
// Above it the rod shows and stays rod_d; below it the rod may thicken.
function rod_surface_hidden(z) =
  let (r = rod_d_hidden / 2)
  len([for (p = [[rod_x(), rod_y() + r, z], [rod_x() - r, rod_y(), z], [rod_x() + r, rod_y(), z]])
         if (!hidden_from_eye(global_to_ct(p))) p]) == 0;
function rod_hide_z() =
  let (zf = rod_entry()[2] + rod_bend_r, zs = [for (z = [0 : -0.5 : zf]) z],
       ok = [for (i = [0 : len(zs) - 1]) if (len([for (j = [i : len(zs) - 1]) if (!rod_surface_hidden(zs[j])) j]) == 0) zs[i]])
  len(ok) > 0 ? ok[0] : zf;
// The taper from rod_d to rod_d_hidden starts 2 mm below that line.
function rod_taper_z0() = rod_hide_z() - 2;
function rod_taper_len() = min(10, rod_taper_z0() - (rod_entry()[2] + rod_bend_r));

// The cord's top in the pocket, the bend's corner, and the dock's back.
function rod_corners() = [
  [rod_x(), rod_y(), cord_z_top()],
  [rod_x(), rod_y(), rod_entry()[2]],
  rod_entry()
];

// Points along the forward run's top, from the bend's end to the dock.
function rod_visible_pts() =
  let (y0 = rod_y() + rod_bend_r, y1 = rod_entry()[1], z = rod_entry()[2] + rod_d_hidden / 2)
  [for (y = [y0 : 5 : y1]) [rod_x(), y, z], [rod_x(), y1, z]];

// The bend's quarter torus.
module rod_bend() {
  translate([rod_x(), rod_y() + rod_bend_r, rod_entry()[2] + rod_bend_r])
    multmatrix([[0, 0, 1, 0], [-1, 0, 0, 0], [0, -1, 0, 0], [0, 0, 0, 1]])
      rotate_extrude(angle = 90, $fn = $fn_rod)
        translate([rod_bend_r, 0]) circle(d = rod_d_hidden, $fn = $fn_rod);
}

module rod_solid() { rod_body(); }

module rod_body() {
  x = rod_x(); y = rod_y(); zf = rod_entry()[2]; r = rod_bend_r;
  d = rod_d_hidden;
  // The flare reaches past the dock's back all round (it leans forward below
  // the entry by its radius x tan(tilt)) and is cut at the flange's face.
  y_end = rod_entry()[1] + (d + 8) / 2 * tan(tilt) + 1;
  // The top end, D-shaped, up in the socket.
  rod_top_end();
  // Vertical run: rod_d from the plate's bottom edge down to the taper, then
  // rod_d_hidden. (A uniform rod, rod_d_hidden == rod_d, has no taper to place.)
  zt = rod_d_hidden > rod_d ? rod_taper_z0() : zf + r;
  tl = rod_d_hidden > rod_d ? rod_taper_len() : 0;
  translate([x, y, zt]) cylinder(d = rod_d, h = -fit / 2 - zt, $fn = $fn_rod);
  if (tl > 0) {
    translate([x, y, zt - tl]) cylinder(d1 = d, d2 = rod_d, h = tl, $fn = $fn_rod);
    translate([x, y, zf + r]) cylinder(d = d, h = zt - tl - zf - r, $fn = $fn_rod);
  }
  // The bend: a quarter torus in the y-z plane, centred on the corner's
  // inside. rotate_extrude sweeps +X to +Y; mapped so +X -> -y, +Y -> -z.
  rod_bend();
  // Forward run, flaring over its last 8 mm into the flange, and cut off
  // inside the flange, short of its face (a coplanar cut leaves slivers).
  difference() {
    union() {
      translate([x, y + r, zf]) rotate([-90, 0, 0]) cylinder(d = d, h = y_end - y - r - 8, $fn = $fn_rod);
      translate([x, y_end - 8, zf]) rotate([-90, 0, 0]) cylinder(d1 = d, d2 = d + 8, h = 8, $fn = $fn_rod);
    }
    ct_place() translate([-50, joint_centre()[1] - fit / 2 - 0.5, -ct_h - 50]) cube([ct_w + 100, 100, ct_h + 100]);
  }
  ct_place() flange_local();
}

function cord_corners() = dedupe([
  rod_corners()[0],
  rod_corners()[1],
  rod_entry(),
  ct_to_global(dock_cord_end())
]);

function cord_path() = round_path(cord_corners(), cord_bend_r);

// margin grows the channel, so the leak test can demand a minimum wall.
module cord_channel(margin = 0) { tube(cord_path(), cord_d + 1 + 2 * margin); }
