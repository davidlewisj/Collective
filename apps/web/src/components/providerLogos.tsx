/**
 * Meeting-provider brand marks for the "Join now" button. These are official
 * brand logos (supplied by the workspace owner) used purely as a join
 * affordance — the one place the app carries hardcoded brand colors rather than
 * design tokens. Google Meet falls back to a neutral video glyph until an
 * official asset is supplied.
 */
import type { JoinProvider } from "../api";

function TeamsLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#5059C9"
        d="M10.765 6.875h3.616c.342 0 .619.276.619.617v3.288a2.272 2.272 0 01-2.274 2.27h-.01a2.272 2.272 0 01-2.274-2.27V7.199c0-.179.145-.323.323-.323zM13.21 6.225c.808 0 1.464-.655 1.464-1.462 0-.808-.656-1.463-1.465-1.463s-1.465.655-1.465 1.463c0 .807.656 1.462 1.465 1.462z"
      />
      <path
        fill="#7B83EB"
        d="M8.651 6.225a2.114 2.114 0 002.117-2.112A2.114 2.114 0 008.65 2a2.114 2.114 0 00-2.116 2.112c0 1.167.947 2.113 2.116 2.113zM11.473 6.875h-5.97a.611.611 0 00-.596.625v3.75A3.669 3.669 0 008.488 15a3.669 3.669 0 003.582-3.75V7.5a.611.611 0 00-.597-.625z"
      />
      <path fill="url(#collective-teams-grad)" d="M1.597 4.925h5.969c.33 0 .597.267.597.596v5.958a.596.596 0 01-.597.596h-5.97A.596.596 0 011 11.479V5.521c0-.33.267-.596.597-.596z" />
      <path fill="#ffffff" d="M6.152 7.193H4.959v3.243h-.76V7.193H3.01v-.63h3.141v.63z" />
      <defs>
        <linearGradient id="collective-teams-grad" x1="2.244" x2="6.906" y1="4.46" y2="12.548" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5A62C3" />
          <stop offset=".5" stopColor="#4D55BD" />
          <stop offset="1" stopColor="#3940AB" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ZoomLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#4087FC"
        d="M2 11.6C2 8.23969 2 6.55953 2.65396 5.27606C3.2292 4.14708 4.14708 3.2292 5.27606 2.65396C6.55953 2 8.23969 2 11.6 2H20.4C23.7603 2 25.4405 2 26.7239 2.65396C27.8529 3.2292 28.7708 4.14708 29.346 5.27606C30 6.55953 30 8.23969 30 11.6V20.4C30 23.7603 30 25.4405 29.346 26.7239C28.7708 27.8529 27.8529 28.7708 26.7239 29.346C25.4405 30 23.7603 30 20.4 30H11.6C8.23969 30 6.55953 30 5.27606 29.346C4.14708 28.7708 3.2292 27.8529 2.65396 26.7239C2 25.4405 2 23.7603 2 20.4V11.6Z"
      />
      <path
        fill="#ffffff"
        d="M8.26667 10C7.56711 10 7 10.6396 7 11.4286V18.3571C7 20.369 8.44612 22 10.23 22L17.7333 21.9286C18.4329 21.9286 19 21.289 19 20.5V13.5C19 11.4881 17.2839 10 15.5 10L8.26667 10Z"
      />
      <path
        fill="#ffffff"
        d="M20.7122 12.7276C20.2596 13.1752 20 13.8211 20 14.5V17.3993C20 18.0782 20.2596 18.7242 20.7122 19.1717L23.5288 21.6525C24.1019 22.2191 25 21.7601 25 20.9005V11.1352C25 10.2755 24.1019 9.81654 23.5288 10.3832L20.7122 12.7276Z"
      />
    </svg>
  );
}

/** Neutral camera glyph — used for Meet (no supplied asset) or any fallback. */
function VideoGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6.5" width="12" height="11" rx="2.5" />
      <path d="M15 10l5.5-3v10L15 14z" />
    </svg>
  );
}

/** In-person meeting mark (people) for the "Start now" button. Inherits color. */
export function InPersonGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M22,7c-1.654,0-3,1.346-3,3c0,0.68,0.236,1.301,0.619,1.805C18.642,12.535,18,13.69,18,15h-4 c0-1.31-0.642-2.465-1.619-3.195C12.764,11.301,13,10.68,13,10c0-1.654-1.346-3-3-3s-3,1.346-3,3c0,0.68,0.236,1.301,0.619,1.805 C6.642,12.535,6,13.69,6,15H5c-0.469,0-0.875,0.326-0.976,0.783l-2,9c-0.066,0.296,0.006,0.606,0.196,0.842 C2.41,25.862,2.697,26,3,26h3.556C6.212,26.591,6,27.268,6,28v1c0,0.552,0.448,1,1,1h6c0.552,0,1-0.448,1-1v-1 c0-0.732-0.212-1.409-0.556-2h5.113C18.212,26.591,18,27.268,18,28v1c0,0.552,0.448,1,1,1h6c0.552,0,1-0.448,1-1v-1 c0-0.732-0.212-1.409-0.556-2H29c0.303,0,0.59-0.138,0.78-0.375c0.189-0.236,0.262-0.546,0.196-0.842l-2-9 C27.875,15.326,27.469,15,27,15h-1c0-1.31-0.642-2.465-1.619-3.195C24.764,11.301,25,10.68,25,10C25,8.346,23.654,7,22,7z M21,10 c0-0.551,0.449-1,1-1s1,0.449,1,1s-0.449,1-1,1S21,10.551,21,10z M9,10c0-0.551,0.449-1,1-1s1,0.449,1,1s-0.449,1-1,1 S9,10.551,9,10z M10,13c1.103,0,2,0.897,2,2H8C8,13.897,8.897,13,10,13z M9,23c0-0.551,0.449-1,1-1s1,0.449,1,1s-0.449,1-1,1 S9,23.551,9,23z M12,28H8c0-1.103,0.897-2,2-2S12,26.897,12,28z M21,23c0-0.551,0.449-1,1-1s1,0.449,1,1s-0.449,1-1,1 S21,23.551,21,23z M24,28h-4c0-1.103,0.897-2,2-2S24,26.897,24,28z M26.198,17l1.556,7h-2.938C24.928,23.686,25,23.352,25,23 c0-1.654-1.346-3-3-3s-3,1.346-3,3c0,0.352,0.072,0.686,0.184,1h-6.369C12.928,23.686,13,23.352,13,23c0-1.654-1.346-3-3-3 s-3,1.346-3,3c0,0.352,0.072,0.686,0.184,1H4.247l1.556-7H7h6h6h6H26.198z M20,15c0-1.103,0.897-2,2-2s2,0.897,2,2H20z" />
      <path d="M18,2h-4c-1.654,0-3,1.346-3,3s1.346,3,3,3h0.865l1.367,1.64C16.423,9.87,16.705,10,17,10c0.038,0,0.077-0.002,0.115-0.007 c0.335-0.039,0.628-0.244,0.779-0.546l0.759-1.519C19.995,7.629,21,6.43,21,5C21,3.346,19.654,2,18,2z M18,6 c-0.379,0-0.725,0.214-0.895,0.553L16.79,7.185L16.102,6.36C15.912,6.132,15.63,6,15.333,6H14c-0.551,0-1-0.449-1-1s0.449-1,1-1h4 c0.551,0,1,0.449,1,1S18.551,6,18,6z" />
    </svg>
  );
}

export function ProviderLogo({ provider, size = 18 }: { provider: JoinProvider; size?: number }) {
  if (provider === "teams") return <TeamsLogo size={size} />;
  if (provider === "zoom") return <ZoomLogo size={size} />;
  return <VideoGlyph size={size} />;
}

export const PROVIDER_LABEL: Record<JoinProvider, string> = {
  teams: "Teams",
  zoom: "Zoom",
  meet: "Meet",
};
