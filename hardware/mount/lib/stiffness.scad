// How far a firm press on the end button of the top row moves the Car Thing,
// from the rod alone, as a simple beam estimate. The press pushes down (-z)
// at button_x_off() to the side of the rod's axis. The vertical run is fused to
// the plate above the monitor's bottom edge (z = 0), so only its length below
// that bends.
//   1. the forward run bends as a cantilever from the bend, loaded past its
//      end at the button;
//   2. the vertical run bends under the press's moment about x, and tips
//      everything out to the button;
//   3. the forward run twists under the press's moment about its axis, seen
//      at the button;
//   4. the vertical run bends sideways under that same moment, seen at the
//      button.
// The vertical run is rod_d down to where it's hidden from the seat, and
// rod_d_hidden below; the taper between them is counted at rod_d.

// The farther end button's distance from the rod's axis.
function button_x_off() = max([for (b = ct_end_buttons) abs(b - joint_x)]);

function rod_I(d) = PI * (pow(d, 4) - pow(cord_d + 1, 4)) / 64;
// The forward run's length, from the vertical run's axis to the dock's back.
function rod_Lf() = rod_entry()[1] - rod_y();
function rod_Lv() = -rod_entry()[2];
// The press's lever from the vertical run's axis: the button sits on the top
// edge at mid-thickness, past the dock's back. Past the forward run's end the
// dock and the Car Thing are taken as rigid.
function button_arm() = ct_to_global([0, ct_t / 2, 0])[1] - rod_y();

function sag_terms() =
  let (
    F = press_N, e = button_x_off(), Lf = rod_Lf(), Lv = rod_Lv(), Lb = button_arm(), a = Lb - Lf,
    Ih = rod_I(rod_d_hidden), Iv = rod_I(rod_d),
    Lthin = rod_d_hidden > rod_d ? -(rod_taper_z0() - rod_taper_len()) : Lv, Lthick = Lv - Lthin,
    flex_v = Lthin / (petg_E * Iv) + Lthick / (petg_E * Ih),  // rotation per unit moment
    // The forward run as a cantilever with the load a past its end: the tip's
    // deflection and rotation, carried out to the button.
    tip = F * pow(Lf, 3) / (3 * petg_E * Ih) + F * a * pow(Lf, 2) / (2 * petg_E * Ih),
    rot = F * pow(Lf, 2) / (2 * petg_E * Ih) + F * a * Lf / (petg_E * Ih)
  ) [
    tip + rot * a,
    F * Lb * flex_v * Lb,
    F * e * Lf / (petg_G * 2 * Ih) * e,
    F * e * flex_v * e
  ];

function button_sag() = let (t = sag_terms()) t[0] + t[1] + t[2] + t[3];
