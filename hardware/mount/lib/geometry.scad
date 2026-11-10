// Where the tilted backplate and the Car Thing sit, as functions the parts and
// the checks share.
//
// The backplate is built in the Car Thing's own frame ("local"): x along its
// width (0 at its left edge), y out of its back face (0 at the back face,
// ct_t at the screen), z up its face (0 at its top edge, -ct_h at the bottom).
// ct_place() turns that frame into the mount's coordinates.

// The magnet pocket, a web, and the nut pocket opening on the hidden back.
// The stud is cut short to fit (stud_cut() in magnet.scad).
function backplate_thickness() = magnet_t + magnet_web + nut_t + 0.4;

// Leaning back by `tilt` about X: (y, z) -> (y cos - z sin, y sin + z cos).
function lean(p) = [p[0] * cos(tilt) - p[1] * sin(tilt), p[0] * sin(tilt) + p[1] * cos(tilt)];

// The backplate's back face starts ct_reach past the screen face, and the Car
// Thing's top-front corner sits ct_top_gap below the monitor's bottom edge.
function ct_origin() = [
  monitor_depth + ct_reach + backplate_thickness() * cos(tilt),
  -ct_top_gap - ct_t * sin(tilt)
];

// The rod meets the Car Thing joint_x from its tab end (joint.scad); it may
// overhang the plate.
function ct_x0() = rod_x() - joint_x;

// Local [x, y, z] -> mount [x, y, z].
function ct_to_global(p) =
  let (o = ct_origin(), r = lean([p[1], p[2]]))
  [p[0] + ct_x0(), o[0] + r[0], o[1] + r[1]];

// Mount [x, y, z] -> local [x, y, z]: the inverse of ct_to_global.
function global_to_ct(g) =
  let (o = ct_origin(), y = g[1] - o[0], z = g[2] - o[1])
  [g[0] - ct_x0(), y * cos(tilt) + z * sin(tilt), -y * sin(tilt) + z * cos(tilt)];

// The owner's eyes, in the mount's coordinates. The owner sits centred on the
// monitor, and the Car Thing's centre is mount_x to the right of that.
function eye_global() = [ct_x0() + ct_w / 2 - mount_x, monitor_depth + eye[0], eye[1]];

// True when the Car Thing's body hides a point (in its local frame) from the
// owner's eyes. A point behind the back face (y < 0) is hidden when the line
// to the eye passes through the back face inside its outline (shrunk by the
// edge margin, with rounded corners); a point in front of it must lie inside
// that outline.
function in_ct_outline(q) =
  let (
    r = ct_corner_r - ct_edge_margin,
    cx = min(max(q[0], ct_corner_r), ct_w - ct_corner_r),
    cz = min(max(q[2], -ct_h + ct_corner_r), -ct_corner_r)
  ) norm([q[0] - cx, q[2] - cz]) <= r;
function hidden_from_eye(p) =
  let (e = global_to_ct(eye_global()))
  p[1] >= 0 ? in_ct_outline(p)
            : let (t = (0 - e[1]) / (p[1] - e[1])) in_ct_outline(e + t * (p - e));

module ct_place() {
  o = ct_origin();
  translate([ct_x0(), o[0], o[1]]) rotate([tilt, 0, 0]) children();
}

// The inverse of ct_place(): mount coordinates back to the local frame.
module ct_unplace() {
  o = ct_origin();
  rotate([-tilt, 0, 0]) translate(-[ct_x0(), o[0], o[1]]) children();
}

// The Car Thing's side profile after tilt, as [y, z] corners:
// back-top, front-top, front-bottom, back-bottom.
function ct_corners() = [
  for (c = [[0, 0], [ct_t, 0], [ct_t, -ct_h], [0, -ct_h]])
    let (g = ct_to_global([0, c[0], c[1]])) [g[1], g[2]]
];

// Height of the line from the owner's eyes to the screen's bottom edge, at y.
function sight_line_z(y) = (y - monitor_depth) * eye[1] / eye[0];

function lowest_z() = min([for (c = ct_corners()) c[1]]);

// The model reads as the owner sees it, x to their right and y toward them,
// which makes a left-handed frame; OpenSCAD's is right-handed. So every
// printed part and render goes out mirrored in x, and the real part matches.
function as_owner_pt(p) = [-p[0], p[1], p[2]];
module as_owner() { mirror([1, 0, 0]) children(); }
