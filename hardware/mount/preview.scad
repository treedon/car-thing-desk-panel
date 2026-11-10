// Renders only: the main mount with a stand-in Car Thing and monitor, to see
// the design from the owner's seat, the side and behind. build.sh writes
// renders/{seat,side,back}.png; `build.sh --camera <view>` prints the camera.
//   view = "seat": from eye_global(), perspective
//          "side": from +x, orthographic
//          "back": from behind and below, showing the dock
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
use <main-mount.scad>

view = "seat";

target = as_owner_pt(ct_to_global([ct_w / 2, ct_t / 2, -ct_h / 2]));
eye_pt = as_owner_pt(eye_global());
cam =
  view == "side" ? concat(target + [500, 0, 0], target) :
  view == "back" ? concat(target + [-180, -360, -160], target) :
  concat(eye_pt, target);
echo(camera = cam);

// The Car Thing, in its local frame: the thin body with the raised platform
// on its back, the dial on its front at the dial end, the buttons on the top
// edge.
module ct_mock() {
  color([0.13, 0.13, 0.14]) {
    translate([0, ct_t, 0]) soft_slab([0, ct_w], [-ct_h, 0], ct_t - ct_step, ct_corner_r, 2);
    // The platform, its long sides sloping down to the body.
    hull() {
      translate([ct_platform[0], 0, -ct_h + 11]) cube([ct_platform[1] - ct_platform[0], 0.01, ct_h - 22]);
      translate([ct_platform[0], ct_step + 0.5, -ct_h + 5]) cube([ct_platform[1] - ct_platform[0], 0.01, ct_h - 10]);
    }
  }
  // Screen
  color([0.04, 0.04, 0.05]) translate([8, ct_t - 0.4, -ct_h + 8]) cube([ct_w - 52, 0.6, ct_h - 16]);
  color([0.11, 0.73, 0.33]) translate([20, ct_t - 0.2, -ct_h / 2 - 6]) cube([40, 0.4, 12]);
  // Dial on the front face at the dial end
  dial_d = 36;
  color([0.2, 0.2, 0.21]) translate([ct_w + ct_dial_overhang - dial_d / 2, ct_t, -dial_d / 2 - 2]) rotate([-90, 0, 0]) cylinder(d = dial_d, h = 8, $fn = 72);
  // Buttons
  color([0.3, 0.3, 0.31]) for (i = [0 : 3]) translate([10 + i * 16, ct_t / 2 - 4, -0.5]) cube([12, 8, 2]);
}

module monitor_mock() {
  mx = eye_global()[0];
  color([0.7, 0.7, 0.72]) translate([mx - 309, 0, 0]) cube([618, monitor_depth, 360]);
  color([0.05, 0.05, 0.07]) translate([mx - 303, monitor_depth - 0.2, 12]) cube([606, 0.4, 342]);
}

as_owner() {
  color([0.09, 0.09, 0.1]) mount_solid();
  ct_place() ct_mock();
  monitor_mock();
}
