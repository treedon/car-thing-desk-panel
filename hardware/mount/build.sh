#!/usr/bin/env bash
# Renders the printable parts to stl/, each lying as it prints, converts them to step/
# for Fusion, and renders renders/{seat,side,back}.png from preview.scad.
#   build.sh --camera <seat|side|back>   prints that view's camera and exits OpenSCAD can't write STEP, so FreeCAD rebuilds a solid from
# the mesh: flat faces merge cleanly, and curves stay faceted.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

camera() { # view -> "ex,ey,ez,cx,cy,cz" from preview.scad's echo
  local echo_file
  echo_file=$(mktemp -t camera).echo
  openscad --backend=Manifold -o "$echo_file" -D "view=\"$1\"" preview.scad >/dev/null 2>&1
  sed -n 's/^ECHO: camera = \[\(.*\)\]$/\1/p' "$echo_file" | tr -d ' '
  rm -f "$echo_file"
}
if [ "${1-}" = --camera ]; then camera "$2"; exit; fi
freecadcmd="${FREECADCMD:-/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd}"
mkdir -p stl step

render() { # out, file, extra openscad args...
  local out=$1 file=$2; shift 2
  openscad --hardwarnings --backend=Manifold --export-format binstl -o "stl/$out.stl" "$@" "$file"
}

for p in plate rod dock; do render "$p" main-mount.scad -D "part=\"$p\""; done
render standalone-shelf standalone-shelf.scad
for c in magnet slot socket; do render "coupon-$c" coupons.scad -D "part=\"$c\""; done

# freecadcmd doesn't pass the environment through, so the paths go in the code,
# and its exit code doesn't reflect the script's, so the result is read back.
for part in plate rod dock standalone-shelf; do
  out=$("$freecadcmd" -c "
import Mesh, Part
mesh = Mesh.Mesh('$here/stl/$part.stl')
shape = Part.Shape()
shape.makeShapeFromMesh(mesh.Topology, 0.05)
shape.sewShape()
solid = Part.makeSolid(shape)
try:
    solid = solid.removeSplitter()
except Part.OCCError:
    print('step $part: merging faces failed; keeping the triangulated solid')
solid.exportStep('$here/step/$part.step')
print('step $part faces', len(solid.Faces), 'valid', solid.isValid())
" 2>&1)
  printf '%s\n' "$out" | grep '^step'
  printf '%s\n' "$out" | grep -q "^step $part faces .* valid True" || { echo "STEP export of $part failed" >&2; exit 1; }
done

# Views of the design with a stand-in Car Thing and monitor.
mkdir -p renders
for view in seat side back; do
  proj=p; [ "$view" = side ] && proj=o
  openscad --hardwarnings --backend=Manifold -o "renders/$view.png" -D "view=\"$view\"" \
    --camera="$(camera "$view")" --projection=$proj --imgsize=1400,1000 --colorscheme=Tomorrow preview.scad
done
