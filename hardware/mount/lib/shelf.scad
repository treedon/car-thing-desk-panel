// One shelf slot: a floor and a tall lip along the long side, no end walls.
// Attaches to a plate's back face at y = 0 and reaches into -Y; the floor's
// top is z = 0. The item stands ports-down: the floor is open down the middle
// for its plugs, and the item rests on a ledge each side. The floor stays
// solid at each end, and that is what ties the lip to the plate.

function slot_inner() = item_t + slot_clear;
function slot_depth() = slot_inner() + wall;
// How far the slot reaches below its floor's top: the floor and the fillet
// under it. No gussets: they would hang below the plate.
function shelf_below() = floor_t + soft_r;
// The standalone shelf's plate corners, and its slot's height above the
// plate's bottom: as on the main mount, so the plugs end above it.
function standalone_r() = plate_r;
function standalone_slot_z() = shelf_z;
// The standalone shelf's plate: tall enough to resist peel and to back the item.
function standalone_h() = max(3 * slot_depth(), standalone_slot_z() + item_h + 4);

// How far below the floor's top the slot reaches: the floor and the fillet under it.
function shelf_reach() = floor_t + soft_r + 1;

// The slot's side profile in (y, z), with a stub of the plate behind it so
// the floor's root gets a fillet; inside corners get a soft_r fillet and
// outside corners as much round as the 2.4 mm lip allows.
module shelf_profile() {
  d = slot_depth();
  lo = shelf_reach();
  soft_2d(soft_r, min(soft_r, wall / 2 - 0.2)) union() {
    translate([-d, -floor_t]) square([d + 0.01, floor_t]);
    translate([-d, 0]) square([wall, lip_h]);
    translate([0, -lo]) square([plate_t, lo + lip_h + 4]);
  }
}

// The item standing ports-down in a slot of length len, centred along it,
// with its plugs below it. The plugs run its whole length, since their
// positions along the edge vary. It sits half a millimetre up, on the
// fillets in the slot's inside corners. For the clash test.
module shelf_item(len) {
  x0 = (len - item_len) / 2;
  translate([x0, -(slot_inner() + item_t) / 2, 0.5]) cube([item_len, item_t, item_h]);
  translate([x0, -(slot_inner() + item_plug_t) / 2, 0.5 - item_plug_drop]) cube([item_len, item_plug_t, item_plug_drop]);
}

module shelf_slot(len) {
  d = slot_depth();
  lo = shelf_reach();
  difference() {
    // The profile, extruded along x, with the plate stub clipped back into the plate.
    intersection() {
      rotate([90, 0, 90]) linear_extrude(len) shelf_profile();
      translate([-1, -d - 1, -lo]) cube([len + 2, d + 1 + plate_t, lo + lip_h + 6]);
    }
    // The opening for the plugs, between the ledges and the solid ends, its
    // corners chamfered at 45 degrees.
    translate([0, 0, -lo - 1]) linear_extrude(lo + 2)
      offset(delta = 2, chamfer = true) offset(delta = -2)
        translate([floor_end, -slot_inner() + ledge]) square([len - 2 * floor_end, slot_inner() - 2 * ledge]);
  }
}
