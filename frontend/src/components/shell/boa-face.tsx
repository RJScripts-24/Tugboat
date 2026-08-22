import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * Boa's face.
 *
 * The artwork is a two-frame sheet - eyes open on the left, eyes closed on the
 * right - and this shows one frame at a time through a round window, swapping
 * between them on a blink rhythm. Nothing here is generated: it is the
 * supplied drawing, cropped to the head and animated.
 *
 * Done as a sprite rather than two stacked images that cross-fade, because a
 * blink is not a fade. Eyelids are either down or they are not, and 120ms of
 * opacity between the two states reads as a ghost rather than a blink.
 *
 * The whole thing is CSS. No timer, no state, no `Math.random()` - which
 * matters more than it sounds: the sidebar renders on the server, and an agent
 * whose face is driven by a client clock is an agent whose first paint is a
 * hydration mismatch.
 */

/** The sheet, in its own pixels. Two frames side by side. */
const SHEET = { width: 768, height: 512 };

/**
 * The window into one frame: a square around the head, found by eye against
 * the artwork. `ox`/`oy` are its top-left corner inside the left frame and
 * `size` is its side - all in sheet pixels, so the geometry below is one
 * division away from being readable.
 */
const FACE = { ox: 104, oy: 130, size: 165 };

export function BoaFace({
  size = 44,
  className = "",
}: {
  /** Rendered diameter in pixels. The crop scales with it. */
  size?: number;
  className?: string;
}) {
  const style = {
    width: size,
    height: size,
    // The sheet, scaled so that FACE.size source pixels fill the window.
    "--boa-sheet-w": `${(SHEET.width / FACE.size) * 100}%`,
    // Percentages on a positioned child resolve against this box, which is
    // square - so one expression works for both axes and any diameter.
    "--boa-face-x": `${(-FACE.ox / FACE.size) * 100}%`,
    "--boa-face-y": `${(-FACE.oy / FACE.size) * 100}%`,
  } as CSSProperties;

  return (
    <span className={`boa-face ${className}`} style={style} role="img" aria-label="Boa">
      <Image
        src="/media/boa-face.png"
        alt=""
        width={SHEET.width}
        height={SHEET.height}
        priority
        className="boa-sheet"
      />
    </span>
  );
}
