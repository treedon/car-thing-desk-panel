// The dock: the hidden backplate behind the Car Thing, in its local frame
// (see geometry.scad). A rounded slab bears on the Car Thing's raised
// platform and stands ct_step clear of its thin ends; the pot magnet sits
// flush in its front, on the platform; a block over the thin tab end holds
// the USB-C plug breakout, pointing +x at the port in the platform's end wall.
//
// The board lies in the x-z plane at y = ct_port_y, its plug through a slot
// in the block's shoulder (the +x face). The shoulder is the hard stop: the
// Car Thing slides -x onto the plug until the port wall meets it. The board
// slides in from the block's open bottom and is potted with epoxy; the -x end
// is closed and takes the docking push. The cord reaches the board from
// behind, through the backplate. The rod is a separate print: its spigot
// glues into a hole in the dock's back (joint.scad), behind the board.

// The block's length along x from the port wall: shoulder, board, closed end.
function dock_block_len() = plug_shoulder + plug_board[1] + fit + wall;
// How far the plug goes into the port.
function dock_engaged() = plug_len - plug_shoulder;
// The block's furthest local y, toward the thin end's surface: the board plus
// a thin wall. The plug's shell may pass beyond it, through the shoulder slot.
function dock_block_front() = ct_port_y + plug_board[2] / 2 + fit + dock_floor_wall;
function dock_block_half_h() = plug_board[0] / 2 + fit + wall;
// Where the cord channel ends: behind the board, under the rod's axis.
function dock_cord_end() = [joint_x, ct_port_y - plug_board[2] / 2 - 1.5, -ct_port_z];

function dock_x1() = ct_platform[0] - fit;  // the shoulder face
function dock_board_x0() = dock_x1() - plug_shoulder - plug_board[1] - fit;  // the board's far end
function dock_plate_box() = [[bp_inset, ct_w - bp_inset], [-ct_h + bp_inset, -bp_inset]];  // [x range, z range]

// Points the visibility rule tests: the plate's real rounded outline at its
// front face, where its back edge round starts, and on its back face (shrunk
// by that round), every 10 degrees around each corner; and the block's corners.
function dock_outline_pts() =
  let (
    b = dock_plate_box(), bt = backplate_thickness(), rr = bp_r / 2,
    zc = -ct_port_z, h = dock_block_half_h(),
    corners = [[b[0][0] + bp_r, b[1][0] + bp_r, 180], [b[0][1] - bp_r, b[1][0] + bp_r, 270],
               [b[0][1] - bp_r, b[1][1] - bp_r, 0], [b[0][0] + bp_r, b[1][1] - bp_r, 90]]
  )
  concat(
    [for (c = corners, a = [c[2] : 10 : c[2] + 90], yr = [[0, bp_r], [-bt + rr, bp_r], [-bt, bp_r - rr]])
       [c[0] + yr[1] * cos(a), yr[0], c[1] + yr[1] * sin(a)]],
    [for (x = [dock_x1() - dock_block_len(), dock_x1()], z = [zc - h, zc + h], y = [0, dock_block_front()]) [x, y, z]]
  );

// The board pocket and the plug's slot through the shoulder, as a box in the
// local frame: [[x0, y0, z0], [x1, y1, z1]].
function dock_board_box() = [
  [dock_board_x0(), ct_port_y - plug_board[2] / 2 - 2.5, -ct_port_z - dock_block_half_h() - 1],
  [dock_x1() + 1, dock_block_front(), -ct_port_z + dock_block_half_h()]
];

module dock_plate() {
  b = dock_plate_box();
  soft_slab(b[0], b[1], backplate_thickness(), bp_r, bp_r / 2);
}

module dock_block() {
  zc = -ct_port_z;
  h = dock_block_half_h();
  r = 1;
  hull() for (x = [dock_x1() - dock_block_len() + r, dock_x1() - r],
              y = [-1, dock_block_front() - r],
              z = [zc - h + r, zc + h - r])
    translate([x, y, z]) sphere(r = r, $fn = 16);
}

module dock_board_pocket() {
  zc = -ct_port_z;
  bw = plug_board[0] + fit;
  x1 = dock_board_x0();
  // The board, with room behind it (-y) for the solder joints, open to the
  // block's bottom so it slides in.
  translate([x1, ct_port_y - plug_board[2] / 2 - 2.5, zc - dock_block_half_h() - 1])
    cube([plug_board[1] + fit, plug_board[2] + 2.5 + fit, bw / 2 + dock_block_half_h() + 1]);
  // The plug's shell through the shoulder, also open to the bottom.
  translate([dock_x1() - plug_shoulder - 1, ct_port_y - (plug_t + fit) / 2, zc - dock_block_half_h() - 1])
    cube([plug_shoulder + 2, plug_t + fit, (plug_w + fit) / 2 + dock_block_half_h() + 1]);
}

module dock_local() {
  difference() {
    union() {
      dock_plate();
      dock_block();
    }
    translate([ct_magnet_center[0], 0, -ct_magnet_center[1]]) rotate([-90, 0, 0]) magnet_seat();
    dock_board_pocket();
    spigot_hole_local();
  }
}
