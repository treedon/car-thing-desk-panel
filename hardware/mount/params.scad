// Every dimension of the monitor mount, in millimetres and degrees.
// Lines marked MEASURE are placeholders until the owner measures the real part.
//
// Coordinates: origin at the monitor's bottom edge, on its back face, at the
// plate's left edge. +X runs to the owner's right, +Y toward the owner (the
// screen face is at y = monitor_depth), +Z up (the bottom edge is z = 0).
// That frame is left-handed, so every output is mirrored in x (as_owner() in
// lib/geometry.scad) to make the printed parts match it.

$fn = 64;

// Monitor (Kuycon G27P)
monitor_depth = 22;
tilt = 15;              // backplate leans back from the screen's plane
ct_top_gap = 6;         // Car Thing's top-front edge sits this far below the bottom edge
ct_reach = 0;           // the backplate's back face starts this far past the screen face

// Car Thing, from the owner's photos and measurements (shape confirmed
// 2026-11-06). Its back has one raised flat platform in the middle, with the
// steel the magnet grips, curving down to a thinner end each side: the tab
// end on the left seen from the front, the dial end on the right. The USB-C
// port is in the platform's end wall, facing the tab end. The dial is on the
// front face at the dial end; four buttons are on the top edge.
ct_w = 116;             // measured: width (body, without the dial)
ct_h = 64;              // measured: height
ct_t = 15;              // measured: thickness at the platform
ct_corner_r = 6;        // MEASURE body corner radius seen from the back
ct_edge_margin = 1;     // the body's edges are rounded; count this much of them as see-through
ct_thin_tab = [0, 46];  // measured: x range of the thin end at the tab end
ct_platform = [46, 92]; // measured: x range of the raised platform
ct_thin_dial = [92, 116];  // measured: x range of the thin end at the dial end
ct_step = 5;            // measured 5-6: how far the thin ends sit below the platform
ct_port_z = 32;         // from photo: port centred top to bottom
ct_port_y = 2.2;        // from photo: port centre ~2.0-2.3 below the platform's surface
ct_port_depth = 7;      // MEASURE how far a plug can go into the port
ct_tab = [32, 8, 3];    // MEASURE tab past the tab end: [centre below top, height, how far out]
ct_dial_overhang = 4;   // MEASURE how far the dial sticks out past the dial end

// Magnet (Magnetpro pot magnet)
magnet_d = 43;
magnet_t = 6.1;
stud_d = 6.35;          // 1/4"-20
stud_len = 12.7;        // as bought; cut to stud_cut() before fitting
nut_af = 11.11;         // 1/4-20 hex nut, 7/16" across flats
nut_t = 5.56;
magnet_web = 2;         // plastic between the magnet pocket and the nut pocket
fit = 0.3;              // printed clearance
// The magnet sits centred on the platform: [from left, from top].
ct_magnet_center = [(ct_platform[0] + ct_platform[1]) / 2, ct_h / 2];

// USB-C plug breakout fixed to the mount
plug_w = 9;             // MEASURE plug shell width
plug_t = 3.3;           // MEASURE plug shell thickness
plug_len = 6.5;         // MEASURE length the plug sticks out past the board
plug_board = [12, 15, 1.6];  // MEASURE board [width, length, thickness]
plug_shoulder = 1.2;    // plastic over the board's plug end; the plug passes through it

// Cord from the pocket to the plug
cord_d = 4;             // MEASURE
cord_bend_r = 10;       // MEASURE smallest bend it takes without force

// The dock: the hidden backplate behind the Car Thing
bp_inset = 4;           // the backplate's outline sits this far inside the Car Thing's
bp_r = 6;               // its corner radius; its back edges round at bp_r / 2
dock_floor_wall = 1;    // the plug block's wall toward the thin end's surface

// The rod: rod_d where it shows, rod_d_hidden behind the Car Thing. The owner
// chose one even 22 mm rod (2026-11-04), so it looks the same from any seat
// height.
rod_d = 22;
rod_d_hidden = rod_d;
rod_bend_r = 14;        // the bend's centreline radius
$fn_rod = 96;

// Stiffness under a button press (stiffness.scad)
petg_E = 2000;          // MPa
petg_G = 750;           // MPa
press_N = 5;            // a firm press
ct_end_buttons = [13, 103];  // MEASURE x of the top row's end buttons
// mm, the most a press may move the Car Thing. 0.1 while the rod met the Car
// Thing's centre; it now meets it off-centre (joint_x), behind the plug board.
sag_max = 0.14;
finger_d = 16;          // a fingertip pressing the top buttons

// Plate
plate_t = 4;
plate_r = 10;           // the plates' corner radius
soft_r = 2;             // round on every hidden edge
plate_w = 200;
plate_h = 120;
wall = 2.4;
rib_w = 3;              // the plate's ribs, on its back

// Shelf slots. The items stand ports-down, with plugs in their ports, so the
// floor is open down the middle for the plugs and the item rests on a ledge
// each side.
slot_len = 114.3;       // 4.5 in
item_t = 19.05;         // 3/4 in
item_len = 76.2;        // 3 in
item_h = 50.8;          // 2 in; items stand this tall
item_plug_drop = 40;    // MEASURE how far the plugs stick out below the item, to where the cable can bend
item_plug_t = 10;       // MEASURE the plugs' thickness across the item (ports assumed centred in it)
slot_clear = 1.5;
lip_h = 35;             // past the item's middle, so it can't tip out over it
floor_t = 3;
ledge = 4;              // the item rests on this much floor each side of the opening
floor_end = 12;         // solid floor at each end: all that ties the lip to the plate
shelf_z = item_plug_drop + 2;  // floor top above the plate's bottom edge, so the plugs end above it

// Joints (lib/joint.scad). The mount prints as three parts glued together:
// the plate, the rod and the dock.
socket_depth = 24;      // the rod's top end goes this far up into the pocket's base
socket_flat = 2;        // the D flat on the rod's top end, on the side toward the monitor
socket_cone = 50;       // the socket's top narrows to the cord channel at this angle from horizontal
joint_x = 41;           // the rod meets the dock this far from the tab end: behind the plug board, clear of the magnet
flange_d = 38;          // the flange on the rod's front end, glued flat to the dock's back
flange_t = 4;
spigot_d = 12;          // the teardrop spigot from the flange into the dock, point down, so it fits one way
spigot_len = 6;         // short: the dock is only backplate_thickness() deep

// Pocket for the charge-through cable, C-to-A adapter and dongle
pocket = [60, 30, 22];  // MEASURE contents [x, depth, height]
// The pocket's floor, above the plate's bottom edge: over the rod's socket
// and its cone, in the pocket's solid base.
pocket_z0 = socket_depth + (rod_d + fit - cord_d - 1) / 2 * tan(socket_cone) + wall;
pocket_frame = 4;       // retaining frame around the open outer face
rib_z0 = pocket_z0 + pocket[2] + wall + 2;  // plate ribs start above the pocket; none runs behind the shelf

// Owner's seat
eye = [600, 150];       // MEASURE [distance from screen, height above bottom edge]
mount_x = 150;          // MEASURE the Car Thing's centre, right of the monitor's centre (owner sits centred)
desk_clear = 120;       // MEASURE monitor bottom edge to desk

// Printer (Prusa MK4, with margin)
bed = [240, 200];
