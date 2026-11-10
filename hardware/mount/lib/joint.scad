// The two glued joints that join the three prints.
//
// Rod to plate: the rod's top end, D-shaped, goes up into a socket in the
// pocket's solid base, from the plate's bottom edge. The flat faces the
// monitor (+y), so the rod goes in one way only. Above the socket a cone,
// steep enough to print without support, narrows to the cord channel.
// In the mount's coordinates.
//
// Rod to dock: a flange on the rod's front end sits flat on the dock's back,
// a glue gap of fit / 2 away, and a teardrop spigot, point down, goes into a
// matching hole in the dock. In the Car Thing's local frame (geometry.scad),
// joint_x along the Car Thing, behind the plug board, where the rod meets the dock.

function socket_cone_h() = (rod_d + fit - cord_d - 1) / 2 * tan(socket_cone);

// The keep-side of the D flat: everything at y below the flat.
module d_flat_side(clear, z0, h) {
  translate([rod_x() - rod_d, rod_y() - rod_d, z0])
    cube([2 * rod_d, rod_d + rod_d / 2 - socket_flat + clear, h]);
}

// The rod's top end, from just under the plate's bottom edge up to socket_depth.
module rod_top_end() {
  intersection() {
    translate([rod_x(), rod_y(), -fit / 2]) cylinder(d = rod_d, h = socket_depth + fit / 2, $fn = $fn_rod);
    d_flat_side(0, -fit, socket_depth + 2 * fit);
  }
}

// The socket, fit larger than the rod's end, and the cone above it.
module socket_negative() {
  intersection() {
    union() {
      translate([rod_x(), rod_y(), -1]) cylinder(d = rod_d + fit, h = socket_depth + 1, $fn = $fn_rod);
      // Started 1 mm down and that much wider, so it meets the bore exactly at
      // socket_depth (an overlap there leaves a hairline ledge to print over).
      translate([rod_x(), rod_y(), socket_depth - 1])
        cylinder(d1 = rod_d + fit + 2 / tan(socket_cone), d2 = cord_d + 1, h = socket_cone_h() + 1, $fn = $fn_rod);
    }
    d_flat_side(fit / 2, -2, socket_depth + socket_cone_h() + 4);
  }
}

// A teardrop: a circle of diameter d with a 45 degree point toward +Y.
module teardrop_2d(d) {
  hull() {
    circle(d = d, $fn = 48);
    polygon([[0, d / 2 * sqrt(2)], [-d / 4, 0], [d / 4, 0]]);
  }
}

// The spigot's axis runs along local +y through this point, at the dock's back.
function joint_centre() = [joint_x, -backplate_thickness(), -ct_h / 2];

// The flange and spigot, in the local frame. rotate([-90, 0, 0]) turns the
// extrusion's +z to local +y and the 2D +Y to local -z, so the point is down.
module flange_local() {
  c = joint_centre();
  face = c[1] - fit / 2;
  translate([c[0], face, c[2]]) rotate([90, 0, 0]) cylinder(d = flange_d, h = flange_t, $fn = 96);
  translate([c[0], face - 0.01, c[2]]) rotate([-90, 0, 0])
    linear_extrude(spigot_len + fit / 2 + 0.01) teardrop_2d(spigot_d);
}

// The spigot's hole in the dock.
module spigot_hole_local() {
  c = joint_centre();
  translate([c[0], c[1] - 1, c[2]]) rotate([-90, 0, 0])
    linear_extrude(spigot_len + 0.5 + 1) offset(delta = fit / 2) teardrop_2d(spigot_d);
}

// Points around the flange's rim on both its faces, in the local frame.
function flange_rim_pts() =
  let (c = joint_centre(), r = flange_d / 2)
  [for (a = [0 : 15 : 345], y = [c[1] - fit / 2, c[1] - fit / 2 - flange_t])
     [c[0] + r * cos(a), y, c[2] + r * sin(a)]];
