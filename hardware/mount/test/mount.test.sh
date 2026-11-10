#!/usr/bin/env bash
# The mount's geometry rules hold (checks.scad), and every printable part fits
# the Prusa MK4 in some orientation.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
mount="$here/.."
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
# --hardwarnings: a missing include or undefined function is a failure, not a warning.
scad() { openscad --hardwarnings --backend=Manifold "$@"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# An OpenSCAD render came out empty, without an error (an error also leaves
# the top level object empty).
rendered_empty() { printf '%s' "$1" | grep -q 'top level object is empty' && ! printf '%s' "$1" | grep -q ERROR; }

min_wall=1.2  # three perimeters' worth around the cord channel

rules() { # label, openscad -D args...
  local label=$1; shift
  # Echo export writes assertion failures into the .echo file and still exits 0.
  local log code
  log=$(scad -o "$tmp/checks.echo" "$@" "$mount/checks.scad" 2>&1)
  code=$?
  log="$log
$(cat "$tmp/checks.echo" 2>/dev/null)"
  grep -qE 'ERROR|WARNING' "$tmp/checks.echo" 2>/dev/null && code=1
  check "$label: every geometry rule holds" "[ $code -eq 0 ]"
  [ $code -eq 0 ] || printf '%s\n' "$log" | grep -E 'ERROR|WARNING' | sed 's/^/     /'
}

# Parameters the rules must reject: rendering checks.scad with them fails.
catches() { # label, openscad -D args...
  local label=$1; shift
  local code=0
  scad -o "$tmp/neg.echo" "$@" "$mount/checks.scad" >/dev/null 2>&1 || code=1
  grep -qE 'ERROR|WARNING' "$tmp/neg.echo" 2>/dev/null && code=1
  check "rules catch $label" "[ $code -ne 0 ]"
}

# The cord channel, grown by min_wall, never breaks out of the mount or into
# the magnet seat: the leak render is empty.
leak() { # label, openscad -D args...
  local label=$1; shift
  [ -f "$mount/main-mount.scad" ] || return 0
  local llog
  llog=$(openscad --backend=Manifold -o "$tmp/leak.stl" -D 'part="leak"' -D "leak_margin=$min_wall" "$@" "$mount/main-mount.scad" 2>&1)
  check "$label: at least ${min_wall} mm of wall around the cord channel" "rendered_empty \"\$llog\""
}

# The item, standing ports-down in its slot with its plugs below it, touches
# nothing: the clash render is empty.
clash() { # label, file
  local label=$1 file=$2
  local clog
  clog=$(openscad --backend=Manifold -o "$tmp/clash.stl" -D 'part="clash"' "$mount/$file" 2>&1)
  check "$label: the item and its plugs stand clear of the shelf" "rendered_empty \"\$clog\""
}

# Fits the bed (240 x 200, MK4 with margin) and the height (210) in some orientation.
fits() {
  awk '$1 == "vertex" {
         for (i = 2; i <= 4; i++) { v = $i + 0; if (n == 0 || v < lo[i]) lo[i] = v; if (n == 0 || v > hi[i]) hi[i] = v }
         n++
       }
       END {
         if (n == 0) exit 1
         x = hi[2] - lo[2]; y = hi[3] - lo[3]; z = hi[4] - lo[4]
         printf "     extents %.1f x %.1f x %.1f mm\n", x, y, z > "/dev/stderr"
         split(x " " y " " z, e, " ")
         for (a = 1; a <= 3; a++) for (b = 1; b <= 3; b++) for (c = 1; c <= 3; c++)
           if (a != b && b != c && a != c && e[a] <= 240 && e[b] <= 200 && e[c] <= 210) exit 0
         exit 1
       }' "$1"
}

# Every edge is shared by exactly two triangles, so the slicer and FreeCAD
# see one closed solid (bodies that only touch along an edge break this).
manifold() {
  awk '$1 == "vertex" { v[k++] = sprintf("%.4f,%.4f,%.4f", $2, $3, $4)
         if (k == 3) { for (i = 0; i < 3; i++) { a = v[i]; b = v[(i + 1) % 3]; e[a < b ? a "|" b : b "|" a]++ } k = 0 } }
       END { bad = 0; for (x in e) if (e[x] != 2) bad++
             if (bad) printf "     %d edges not shared by exactly two faces\n", bad > "/dev/stderr"
             exit bad > 0 }' "$1"
}

part() { # name, file, extra openscad args...
  local name=$1 file=$2; shift 2
  local out="$tmp/part.stl"
  local plog
  rm -f "$out"
  plog=$(scad --export-format asciistl -o "$out" "$@" "$mount/$file" 2>&1)
  printf '%s\n' "$plog" > "$tmp/part.log"
  check "$name renders" "[ -s '$out' ] && ! printf '%s' \"\$plog\" | grep -q 'ERROR'"
  check "$name fits the MK4" "fits '$out'"
  check "$name is a single closed solid" "manifold '$out'"
}

rules "default"
rules "the Car Thing 200 mm right of centre" -D mount_x=200
leak "default"
# The three parts in place: they don't overlap anywhere (so the keys line up),
# and none of them leaves material in the cord channel.
empty() { # label, part
  local log; log=$(openscad --backend=Manifold -o "$tmp/e.stl" -D "part=\"$2\"" "$mount/main-mount.scad" 2>&1)
  check "$1" "rendered_empty \"\$log\""
}
empty "the three parts don't overlap when assembled" collide
empty "no part blocks the cord channel" channel
clash "main mount" main-mount.scad
clash "standalone shelf" standalone-shelf.scad
for p in plate rod dock; do
  part "$p" main-mount.scad -D "part=\"$p\""
done

catches "a shallow thin end" -D ct_step=3
catches "the rod meeting the dock over the magnet" -D joint_x=58
catches "a seat far off to the side" -D mount_x=320
catches "the buttons tucked under the monitor" -D ct_reach=-20
catches "a seat that sees a tapered rod's thick part" -D rod_d=20 -D rod_d_hidden=24 -D mount_x=0 -D 'eye=[600,240]'
catches "a lip the item tips over" -D lip_h=7
catches "plugs hanging below the monitor" -D shelf_z=6
catches "ledges too narrow to hold the item" -D ledge=1
catches "a shallow socket" -D socket_depth=12
catches "a narrow flange" -D flange_d=26
catches "a standalone slot in the plate's rounded corners" -D item_plug_drop=5

[ -f "$mount/standalone-shelf.scad" ] && part standalone-shelf standalone-shelf.scad
if [ -f "$mount/coupons.scad" ]; then
  for c in magnet slot socket; do
    part "coupon-$c" coupons.scad -D "part=\"$c\""
  done
fi

# The preview (the mount with a stand-in Car Thing and monitor) renders from
# the owner's seat, as build.sh does for renders/seat.png.
preview() {
  local cam
  cam=$("$mount/build.sh" --camera seat 2>&1)
  check "preview renders from the seat" "[ -n '$cam' ] && openscad --hardwarnings --backend=Manifold -o '$tmp/seat.png' --camera='$cam' --imgsize=400,300 '$mount/preview.scad' >/dev/null 2>&1 && [ -s '$tmp/seat.png' ]"
}
preview

exit $fail
