/** Ícones inline (stroke fino, 1.6px) — nenhum asset externo. */

type P = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const DocIcon = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
    <path d="M14 3v4.5h4.5" />
    <path d="M8.75 12.5h6.5M8.75 16h4.5" />
  </svg>
);

export const ChevronIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const PlusIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const GearIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 3.5v2M12 18.5v2M4.9 7.8l1.7 1M17.4 15.2l1.7 1M4.9 16.2l1.7-1M17.4 8.8l1.7-1" />
  </svg>
);

export const WaveIcon = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M3 12h2M8 12h.01M8 8.5v7M12 5.5v13M16 8.5v7M20 10.5v3" />
  </svg>
);

export const SendIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M5 12h13M13 7l5 5-5 5" />
  </svg>
);

export const StopIcon = ({ size = 14, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
    <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);

export const BackIcon = ({ size = 18, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export const CloseIcon = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const MinusIcon = ({ size = 14, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M5 12h14" />
  </svg>
);

export const SunIcon = ({ size = 16, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.8v1.8M12 19.4v1.8M4.2 12H2.4M21.6 12h-1.8M6.5 6.5 5.2 5.2M18.8 18.8l-1.3-1.3M6.5 17.5l-1.3 1.3M18.8 5.2l-1.3 1.3" />
  </svg>
);

export const ExternalIcon = ({ size = 15, className }: P) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8.5 8.5" />
    <path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
  </svg>
);
