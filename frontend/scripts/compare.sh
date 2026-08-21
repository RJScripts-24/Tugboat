#!/usr/bin/env bash
# Stack a region of the design mockup above the same region of the live render,
# both normalised to the mockup's 1122px width, for eyeballing drift.
#
#   ./compare.sh <shot.png> <out.png> <x> <y> <w> <h> [zoom]
set -euo pipefail

SHOT="$1"; OUT="$2"; X="$3"; Y="$4"; W="$5"; H="$6"; Z="${7:-2}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOCK="$ROOT/design/landing.png"
TMP="$(dirname "$OUT")"

ffmpeg -y -v error -i "$SHOT" -vf "scale=1122:-1" "$TMP/_shot1122.png"
ffmpeg -y -v error -i "$MOCK" -vf "crop=$W:$H:$X:$Y,scale=iw*$Z:ih*$Z:flags=lanczos" "$TMP/_a.png"
ffmpeg -y -v error -i "$TMP/_shot1122.png" -vf "crop=$W:$H:$X:$Y,scale=iw*$Z:ih*$Z:flags=lanczos" "$TMP/_b.png"
ffmpeg -y -v error -i "$TMP/_a.png" -i "$TMP/_b.png" \
  -filter_complex "[0]drawbox=x=0:y=0:w=iw:h=ih:color=0x00000000@0[a];\
[a][1]vstack=inputs=2,drawbox=x=0:y=ih/2-1:w=iw:h=2:color=red@0.9:t=fill" "$OUT"
echo "$OUT  (top = mockup, bottom = render)"
