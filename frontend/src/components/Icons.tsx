// Inline SVG only. Nothing is fetched at runtime (air-gap requirement).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconEvents = (p: P) => (
  <Svg {...p}><path d="M3 6h18M3 12h18M3 18h18" /><circle cx="6.5" cy="6" r="0" /></Svg>
);

export const IconLineage = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="19" cy="18" r="2.4" />
    <path d="M7.4 11l9.3-4.2M7.4 13l9.3 4.2" />
  </Svg>
);

export const IconStudio = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l7.5 4.3v8.6L12 20.3 4.5 15.9V7.3z" /><path d="M12 12l7.5-4.4M12 12v8.3M12 12L4.5 7.6" />
  </Svg>
);

export const IconDemo = (p: P) => (
  <Svg {...p}><path d="M6 4.5l13 7.5-13 7.5z" /></Svg>
);

export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14.2a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5v.2a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1A2 2 0 116 2.6l.1.1a1.6 1.6 0 001.8.3H8a1.6 1.6 0 001-1.5V1a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V8a1.6 1.6 0 001.5 1h.2a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </Svg>
);

export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);

export const IconMoon = (p: P) => (
  <Svg {...p}><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></Svg>
);

export const IconShield = (p: P) => (
  <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></Svg>
);

export const IconShieldAlert = (p: P) => (
  <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M12 8v4M12 16h.01" /></Svg>
);

export const IconAlert = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2h.01" /></Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4.5M12 8h.01" /></Svg>
);

export const IconCloud = (p: P) => (
  <Svg {...p}><path d="M17.5 19a4.5 4.5 0 00.4-9 6 6 0 00-11.6 1.6A3.7 3.7 0 007 19z" /></Svg>
);

export const IconChevronLeft = (p: P) => <Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>;
export const IconChevronRight = (p: P) => <Svg {...p}><path d="M9 5l7 7-7 7" /></Svg>;
export const IconChevronsLeft = (p: P) => <Svg {...p}><path d="M11 5l-7 7 7 7M19 5l-7 7 7 7" /></Svg>;
export const IconChevronsRight = (p: P) => <Svg {...p}><path d="M13 5l7 7-7 7M5 5l7 7-7 7" /></Svg>;
export const IconCaret = (p: P) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>;

export const IconMenu = (p: P) => <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;

export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5.5 5h13l2.5 8v5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18v-5z" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h8" /></Svg>
);

export const IconCheck = (p: P) => <Svg {...p}><path d="M4 12.5l5 5L20 6.5" /></Svg>;

export const IconRefresh = (p: P) => (
  <Svg {...p}><path d="M20 11a8 8 0 10-1.6 6" /><path d="M20 4v7h-7" /></Svg>
);

export const IconSpinner = (p: P) => (
  <Svg {...p} className={`spin ${p.className ?? ''}`}>
    <path d="M12 3a9 9 0 019 9" /><circle cx="12" cy="12" r="9" opacity="0.22" />
  </Svg>
);

export const IconTerminal = (p: P) => (
  <Svg {...p}><path d="M5 7l5 5-5 5M12.5 17H19" /></Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}><path d="M14 4h6v6M20 4l-8.5 8.5" /><path d="M18 14v5a1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 19V7.5A1.5 1.5 0 015 6h5" /></Svg>
);

export const IconSearch = (p: P) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Svg>
);

export const IconHome = (p: P) => (
  <Svg {...p}><path d="M3 10.2L12 3l9 7.2V20a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 20z" /><path d="M9 21.5V12h6v9.5" /></Svg>
);


export const IconSources = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="2.4" /><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16" /></Svg>
);

export const IconOff = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5.5 5.5l13 13" /></Svg>
);

export const IconSparkles = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l1.9 4.1L18 9l-4.1 1.9L12 15l-1.9-4.1L6 9l4.1-1.9zM6 16l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
  </Svg>
);

export const IconCpu = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
  </Svg>
);

export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3L21 2v4h-2v2h-2v2h-2.3" />
  </Svg>
);

export const IconServer = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  </Svg>
);

export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 018 0v4" />
  </Svg>
);

