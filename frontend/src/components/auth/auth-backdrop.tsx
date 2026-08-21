/**
 * The hero's night harbour, reduced to what a login page can carry: two drifting
 * lights and a tide. No video here - the sign-in must paint instantly and cost
 * nothing, so the same scene is rebuilt out of gradients and two SVG tiles.
 */

/** One tile of water. Two of these ride the drift band, so it never seams. */
function WaveTile() {
  return (
    <svg
      viewBox="0 0 1440 180"
      preserveAspectRatio="none"
      className="h-full w-1/2 shrink-0"
      aria-hidden
    >
      {/* Far swell */}
      <path
        d="M0 96c40-34 80-34 120 0s80 34 120 0 80-34 120 0 80 34 120 0 80-34 120 0 80 34 120 0 80-34 120 0 80 34 120 0 80-34 120 0 80 34 120 0 80-34 120 0 80 34 120 0V180H0V96Z"
        fill="#061120"
        fillOpacity="0.9"
      />
      {/* Near swell, with a thread of lamplight on the crest */}
      <path
        d="M0 122c40 30 80 30 120 0s80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0V180H0v-58Z"
        fill="#02070e"
      />
      <path
        d="M0 122c40 30 80 30 120 0s80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0 80 30 120 0 80-30 120 0"
        stroke="#f0ac2a"
        strokeOpacity="0.16"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

export function AuthBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      {/* Sky */}
      <div className="absolute inset-0 bg-[radial-gradient(125%_95%_at_50%_-12%,#0b1728_0%,#050d18_44%,#01040a_100%)]" />

      {/* Harbour lamp, high and warm */}
      <div className="auth-glow auth-glow-lamp left-1/2 top-[-16%] h-[540px] w-[540px] -translate-x-1/2 bg-[radial-gradient(circle,rgba(240,172,42,0.2)_0%,rgba(240,172,42,0.055)_46%,transparent_70%)] sm:left-[54%]" />

      {/* Cold water light, low and off to port */}
      <div className="auth-glow auth-glow-deep bottom-[4%] left-[-18%] h-[560px] w-[560px] bg-[radial-gradient(circle,rgba(123,123,245,0.17)_0%,rgba(74,144,240,0.05)_48%,transparent_72%)]" />

      {/* Horizon */}
      <div className="absolute inset-x-0 bottom-[168px] h-px bg-[linear-gradient(to_right,transparent_0%,rgba(255,255,255,0.07)_35%,rgba(255,255,255,0.07)_65%,transparent_100%)]" />

      {/* Tide */}
      <div className="absolute inset-x-0 bottom-0 h-[180px]">
        <div className="wave-band wave-drift">
          <WaveTile />
          <WaveTile />
        </div>
      </div>

      {/* Sink the water into the page floor */}
      <div className="absolute inset-x-0 bottom-0 h-[190px] bg-[linear-gradient(to_top,#01040a_0%,rgba(1,4,10,0.55)_46%,transparent_100%)]" />
    </div>
  );
}
