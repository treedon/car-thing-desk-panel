// The design's geometric rules. Rendering this file runs every assert;
// test/mount.test.sh fails if any of them does.
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
include <lib/stiffness.scad>

// The Car Thing's back and the owner's view
assert(ct_thin_tab[1] == ct_platform[0] && ct_platform[1] == ct_thin_dial[0], "the back's zones meet");
assert(ct_thin_dial[1] <= ct_w, "the back's zones fit the body");
assert(ct_magnet_center[0] - magnet_d / 2 >= ct_platform[0] - 2 && ct_magnet_center[0] + magnet_d / 2 <= ct_platform[1] + 2,
       "the magnet sits on the raised platform");
assert(hidden_from_eye([ct_w / 2, -1, -ct_h / 2]), "a point just behind the Car Thing's centre is hidden");
assert(!hidden_from_eye([ct_w / 2, -1, 10]), "a point above the Car Thing is visible");
assert(!hidden_from_eye([ct_w + 5, -1, -ct_h / 2]), "a point past its side is visible");
assert(norm(global_to_ct(ct_to_global([10, -3, -20])) - [10, -3, -20]) < 1e-6, "global_to_ct inverts ct_to_global");

// Handedness: seen from the owner's seat in the printed part, the tab end
// (where the plug block sits) is at the Car Thing's left end and the dial at
// its right, as on the real device.
let (
  eye_o = as_owner_pt(eye_global()),
  c = as_owner_pt(ct_to_global([ct_w / 2, 0, -ct_h / 2])),
  m = as_owner_pt(ct_to_global([ct_thin_tab[0], 0, -ct_h / 2])),
  right = cross(c - eye_o, [0, 0, 1])
) assert((m - c) * right < 0, "from the seat, the tab end is at the Car Thing's left end and the dial at its right");

// The dock behind the Car Thing
assert(dock_block_front() <= ct_step - fit, "the block clears the thin end's surface");
assert(dock_x1() - dock_block_len() >= ct_thin_tab[0] + bp_inset, "the block sits over the thin tab end, inside the outline");
assert(dock_engaged() >= 4 && dock_engaged() <= ct_port_depth, "the plug engages 4 mm or more and the shoulder stops it first");
assert(dock_block_half_h() <= ct_port_z - ct_corner_r && dock_block_half_h() <= ct_h - ct_port_z - ct_corner_r,
       "the block stays inside the body's height");
// The tab sticks out past x = 0, so staying inside the outline keeps the plate off it.
assert(bp_inset >= 2, "the backplate stays off the tab and the body's rounded edge");
// The magnet's pocket stays clear of the block, and its rim stays hidden.
assert(ct_magnet_center[0] - (magnet_d + fit) / 2 >= dock_x1(), "the magnet pocket clears the plug block");
assert(len([for (a = [0 : 15 : 359]) let (p = [ct_magnet_center[0] + magnet_d / 2 * cos(a), -magnet_t, -ct_magnet_center[1] + magnet_d / 2 * sin(a)])
            if (!hidden_from_eye(p)) p]) == 0, "the magnet's rim is hidden from the seat");
// The block's wall toward the thin end's surface is thin but whole; the plug's
// shell may pass beyond it.
assert(dock_block_front() - (ct_port_y + plug_board[2] / 2 + fit) >= dock_floor_wall, "the block wraps the board toward the thin end");
assert(len([for (p = dock_outline_pts()) if (!hidden_from_eye(p)) p]) == 0, "the dock is hidden from the seat");

// The magnet grips the Car Thing directly and its stud is fully enclosed.
assert(magnet_pocket_depth() == magnet_t, "no plastic over the magnet face");
assert(backplate_thickness() <= rod_d, "the backplate is no thicker than the rod");
assert(backplate_thickness() - magnet_t - nut_t - 0.4 >= magnet_web, "a web between the magnet and the nut");
assert(stud_cut() >= magnet_web + nut_t, "the cut stud still passes through the nut");
assert(stud_cut() <= backplate_thickness() - magnet_t, "the cut stud stays inside the backplate");

// The rod: one bend, meeting the Car Thing behind the plug board, the cord inside it.
assert(rod_bend_r >= cord_bend_r && rod_bend_r > rod_d_hidden / 2, "the rod's bend takes the cord and isn't self-intersecting");
// Every bend in the cord channel has radius cord_bend_r, with room for it on both sides.
assert(path_fits(cord_corners(), cord_bend_r), "cord bends without kinking");
assert(rod_entry()[2] < -ct_top_gap - rod_bend_r, "the bend sits below the Car Thing's top, behind it");
assert(len([for (p = rod_visible_pts()) if (!hidden_from_eye(global_to_ct(p))) p]) == 0,
       "the rod's forward run is hidden behind the Car Thing");
assert(abs(rod_x() - (ct_x0() + joint_x)) < 0.01, "the rod meets the Car Thing at joint_x");
// The cord runs straight from the rod into the board pocket, behind the board.
assert(joint_x - (cord_d + 1) / 2 >= dock_board_x0() + 1 && joint_x + (cord_d + 1) / 2 <= dock_x1() - plug_shoulder - fit,
       "the cord reaches the board pocket behind the board");
// The spigot's hole and the magnet's nut pocket, both in the dock's back, keep a wall between them.
assert(ct_magnet_center[0] - joint_x - (spigot_d + fit) / 2 - (nut_af + fit) / cos(30) / 2 >= 3,
       "the spigot's hole clears the magnet's nut pocket");
// The joints: the rod's top glues into a socket in the pocket's base, and its
// flange and spigot onto the dock's back. Both are keyed, and stiff enough
// that the stiffness estimate can treat them as rigid.
assert(socket_depth >= rod_d, "the rod's socket is at least as deep as the rod is wide");
assert(min(rod_y() - (rod_d + fit) / 2 + plate_t + pocket[1],
           rod_x() - (rod_d + fit) / 2 - (pocket_x0() - wall),
           pocket_x0() + pocket[0] + wall - rod_x() - (rod_d + fit) / 2) >= 3,
       "the socket has 3 mm of base all round");
assert(flange_d >= rod_d_hidden + 12, "the flange is at least 12 mm wider than the rod");
assert(len([for (p = flange_rim_pts()) if (!hidden_from_eye(p)) p]) == 0, "the flange is hidden from the seat");
assert(-backplate_thickness() + spigot_len + 0.5 + 1 <= ct_port_y - plug_board[2] / 2 - 2.5,
       "the spigot's hole leaves a wall before the board pocket");
// Only the rod_d part shows: the thick part, from the taper's foot down
// through the bend, is hidden from the seat.
assert(rod_d_hidden <= rod_d || rod_taper_len() > 0 && rod_surface_hidden(rod_taper_z0() - rod_taper_len()) && rod_surface_hidden(rod_entry()[2] + rod_bend_r),
       "the thick part of the rod is hidden from the seat");

// A firm press on the end button barely moves the Car Thing. The press acts
// at the button (top edge, mid-thickness), past the dock's back.
assert(abs(button_arm() - (ct_to_global([0, ct_t / 2, 0])[1] - rod_y())) < 1e-6 && button_arm() > rod_Lf(),
       "the stiffness estimate levers from the button, not the dock");
echo(sag_terms = sag_terms(), sag = button_sag(), Lf = rod_Lf(), Lv = rod_Lv(), hide_z = rod_hide_z());
assert(button_sag() <= sag_max, str("a 5 N press on the end button moves the Car Thing ", button_sag(), " mm"));

// The top buttons stay reachable: a fingertip pressing down on the middle of
// the top edge clears the monitor's screen face, with 2 mm to spare.
assert(ct_to_global([0, ct_t / 2, 0])[1] - finger_d / 2 >= monitor_depth + 2,
       "a fingertip on the top buttons clears the monitor");

// Rounded everywhere: the plates' corners and every hidden edge.
assert(plate_r >= 8 && soft_r >= 1.5, "the plate and every hidden edge are rounded");
assert(standalone_r() >= 8, "the standalone shelf's plate is rounded");
assert(min(soft_r, wall / 2 - 0.2) < min(wall, floor_t) / 2, "rounding the shelf's corners can't erase its lip or floor");

// The plate is tall enough that the shelf's load doesn't peel it: the item
// hangs slot_depth() off the plate, and the adhesive's lever is the plate's height.
assert(plate_h >= 3 * slot_depth(), "plate tall enough to resist peel");
// No rib runs behind the shelf: the item and its tall lip stand there.
assert(len([for (x = rib_xs()) if (x + rib_w > shelf_x0() && x < shelf_x0() + slot_len) x]) == 0, "no rib runs behind the shelf");
assert(shelf_z + item_h <= plate_h - plate_r, "the item stands below the plate's rounded top");
assert(standalone_h() >= 3 * slot_depth(), "standalone shelf's plate tall enough to resist peel");

// The shelf hangs from the plate and nothing of it shows below the monitor.
assert(shelf_z - shelf_below() >= 0, "the shelf stays above the plate's bottom edge");

// The rod leaves the plate inside its width.
assert(rod_x() - rod_d_hidden / 2 >= 0 && rod_x() + rod_d_hidden / 2 <= plate_w, "the rod stays on the plate");

// The pocket, the shelf and the rod share the plate without overlapping.
assert(pocket_x0() - wall >= shelf_x0() + slot_len, "the pocket clears the shelf");
assert(pocket_x0() + pocket[0] + wall <= plate_w, "the pocket fits on the plate");
assert(pocket_z0 + pocket[2] + wall <= rib_z0, "the pocket sits below the ribs");
// Open outer face, in case the monitor's metal back blocks Wi-Fi.
assert((pocket[0] - 2 * pocket_frame) * (pocket[2] - 2 * pocket_frame) >= 0.3 * pocket[0] * pocket[2],
       "at least 30% of the pocket's outer face is open");
assert(plate_h - plate_r - rib_z0 >= 30, "the ribs run at least 30 mm");

// Each item drops into its slot with clearance. The monitor leans back, so
// the item always leans out onto the lip: a lip well past the item's middle
// holds it, and the top stays clear to grab.
assert(slot_inner() >= item_t + 1, "the slot clears the item");
assert(lip_h >= item_h / 2 + 5, "the lip reaches well past the item's middle");
assert(item_h - lip_h >= 10, "the item's top stands clear of the lip to grab");
// Ports down: the plugs pass through the floor's opening (the clash test),
// the item rests on a ledge each side, and the floor's solid ends tie the
// lip to the plate.
assert(ledge >= 3, "the item rests on ledges at least 3 mm wide");
assert(floor_end >= 10, "the floor's solid ends are wide enough to carry the lip");
assert(slot_len - 2 * floor_end >= item_len, "the item's whole bottom edge fits over the opening");
assert(shelf_z >= item_plug_drop, "the plugs end above the monitor's bottom edge");
assert(standalone_slot_z() >= item_plug_drop, "the standalone shelf's plugs end above its plate's bottom edge");
// The standalone shelf's slot runs the plate's full width, between its rounded
// corners, so the slot's end prints flat on the bed.
assert(standalone_slot_z() - shelf_below() >= standalone_r() && standalone_slot_z() + lip_h <= standalone_h() - standalone_r(),
       "the standalone slot runs between the plate's rounded corners");

// The Car Thing never covers the screen and never reaches the desk.
assert(max([for (c = ct_corners()) c[1]]) < 0, "Car Thing's top stays below the monitor's bottom edge");
assert(len([for (c = ct_corners()) if (c[0] > monitor_depth && c[1] >= sight_line_z(c[0])) c]) == 0,
       "the sight line from the owner's eyes to the bottom of the screen clears the Car Thing");
assert(lowest_z() > -desk_clear, "the Car Thing stays above the desk");
