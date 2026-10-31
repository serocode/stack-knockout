/**
 * Original logo: a "K" assembled from blocks, with its top-right block
 * knocked loose mid-impact (spark + motion lines). Also exported as an SVG
 * string for the favicon.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs>
<linearGradient id="tkbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
<linearGradient id="tkbk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe7ff"/></linearGradient>
</defs>
<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#tkbg)"/>
<rect x="2" y="2" width="60" height="30" rx="15" fill="#ffffff" opacity=".08"/>
<g fill="url(#tkbk)">
<rect x="12" y="14" width="11" height="11" rx="2.6"/>
<rect x="12" y="26.5" width="11" height="11" rx="2.6"/>
<rect x="12" y="39" width="11" height="11" rx="2.6"/>
<rect x="24.5" y="26.5" width="11" height="11" rx="2.6"/>
<rect x="37" y="39" width="11" height="11" rx="2.6"/>
<rect x="38" y="10" width="11" height="11" rx="2.6" transform="rotate(22 43.5 15.5)"/>
</g>
<g stroke="#ffffff" stroke-linecap="round" stroke-width="2.4" opacity=".85">
<path d="M29 22 L33.5 19.5"/><path d="M30 17 L33.5 15.5"/>
</g>
<path d="M53.5 6.5 l1.6 4.1 4.1 1.6 -4.1 1.6 -1.6 4.1 -1.6 -4.1 -4.1 -1.6 4.1 -1.6z" fill="#fff4b8"/>
</svg>`;

export function LogoMark({ size = 40, className = "" }: { size?: number; className?: string }) {
  return <span className={`logo-mark ${className}`} style={{ width: size, height: size }} aria-hidden dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />;
}

export function Logo({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <div className={`logo logo-${size}`} role="img" aria-label="Tetris Knockout">
      <LogoMark size={size === "lg" ? 76 : 30} className="logo-anim" />
      <div className="wordmark">
        <span className="kicker">TETRIS</span>
        <span className="word">KNOCKOUT</span>
      </div>
    </div>
  );
}
