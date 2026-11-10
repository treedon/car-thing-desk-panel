// The standalone shelf: its own adhesive plate and one slot, to stick
// anywhere on the monitor's back. Prints on its end.
include <params.scad>
include <lib/shelf.scad>
include <lib/soft.scad>
include <lib/geometry.scad>

//   part = "shelf": the printable part, standing on one end of its slot as it prints
//   part = "clash": where the item, standing in the slot with its plugs,
//                   meets the shelf; empty when it fits (test/mount.test.sh)
part = "shelf";

// The plate is as wide as the slot, whose ends print flat on the bed.
module standalone_shelf() {
  soft_slab([0, slot_len], [0, standalone_h()], plate_t, standalone_r(), soft_r);
  translate([0, -plate_t, standalone_slot_z()]) shelf_slot(slot_len);
}

if (part == "shelf") {
  // As owned, x runs from -slot_len to 0; turned up, the x = 0 end sits on the bed.
  rotate([0, 90, 0]) as_owner() standalone_shelf();
} else if (part == "clash") {
  intersection() {
    standalone_shelf();
    translate([0, -plate_t, standalone_slot_z()]) shelf_item(slot_len);
  }
}
