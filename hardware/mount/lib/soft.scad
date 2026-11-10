// Rounded building blocks for the softened parts.

// A slab from y = -t to y = 0, spanning x = [x0, x1] and z = [z0, z1], with
// its corners rounded by r (seen along y) and its back edges (at y = -t)
// rounded by rr. The front face (y = 0) stays flat for adhesive or contact.
module soft_slab(x, z, t, r, rr) {
  hull() for (cx = [x[0] + r, x[1] - r], cz = [z[0] + r, z[1] - r])
    translate([cx, 0, cz]) {
      rotate([90, 0, 0]) cylinder(r = r, h = t - rr, $fn = 48);
      translate([0, -t + rr, 0]) rotate([90, 0, 0]) rotate_extrude($fn = 48)
        translate([r - rr, 0]) circle(r = rr, $fn = 24);
    }
}

// A box [x0..x1] x [y0..y1] x [z0..z1] with every edge rounded by r.
module soft_box(x, y, z, r) {
  hull() for (cx = [x[0] + r, x[1] - r], cy = [y[0] + r, y[1] - r], cz = [z[0] + r, z[1] - r])
    translate([cx, cy, cz]) sphere(r = r, $fn = 24);
}

// 2D: fill concave corners with radius fillet, then round convex corners by
// round (which must be under half the thinnest wall, or the wall vanishes).
module soft_2d(fillet, round) {
  offset(r = round) offset(delta = -round) offset(r = -fillet) offset(delta = fillet) children();
}
