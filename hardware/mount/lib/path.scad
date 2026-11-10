// Polylines with rounded corners, for the cord channel.

function unit(v) = v / norm(v);
function turn(a, c, b) = acos(max(-1, min(1, unit(c - a) * unit(b - c))));
function tangent_len(a, c, b, r) = r * tan(turn(a, c, b) / 2);

// Arc points replacing corner c, radius r.
function fillet(a, c, b, r) =
  let (th = turn(a, c, b))
  th < 0.5 ? [c] :
  let (
    u = unit(c - a), v = unit(b - c),
    L = r * tan(th / 2), s = c - u * L, e = c + v * L,
    o = c + unit(v - u) * (r / cos(th / 2)),
    n = max(2, ceil(th / 10))
  ) [for (i = [0:n]) let (t = i / n) o + r * unit((1 - t) * (s - o) + t * (e - o))];

function round_path(p, r) =
  concat([p[0]], [for (i = [1:len(p) - 2]) each fillet(p[i - 1], p[i], p[i + 1], r)], [p[len(p) - 1]]);

// True when every segment is long enough for the fillets at both its ends.
function path_fits(p, r) =
  len([for (i = [0:len(p) - 2])
    let (
      need = (i > 0 ? tangent_len(p[i - 1], p[i], p[i + 1], r) : 0)
           + (i < len(p) - 2 ? tangent_len(p[i], p[i + 1], p[i + 2], r) : 0)
    ) if (need > norm(p[i + 1] - p[i]) + 0.01) i]) == 0;

// Drops repeated points, so a corner that lands on its neighbour is harmless.
function dedupe(p) = [for (i = [0:len(p) - 1]) if (i == 0 || norm(p[i] - p[i - 1]) > 0.01) p[i]];

// A round tube with a 45 degree peak along its top (+z), so where it runs
// level its roof prints without support.
module tube(p, d) {
  module drop() hull() {
    sphere(d = d, $fn = 16);
    translate([0, 0, d / 2 * sqrt(2)]) sphere(d = 0.01, $fn = 4);
  }
  for (i = [0:len(p) - 2]) hull() {
    translate(p[i]) drop();
    translate(p[i + 1]) drop();
  }
}
