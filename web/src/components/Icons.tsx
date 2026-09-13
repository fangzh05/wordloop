type IconProps = { className?: string };

export function PlayIcon({ className = "" }: IconProps): React.JSX.Element {
  return <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d="M6.5 4.9a1 1 0 0 1 1.54-.84l7.13 4.8a1.36 1.36 0 0 1 0 2.28l-7.13 4.8a1 1 0 0 1-1.54-.84V4.9Z" fill="currentColor" />
  </svg>;
}

export function ReplayIcon({ className = "" }: IconProps): React.JSX.Element {
  return <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d="M4.2 7.2A6.3 6.3 0 1 1 4 12.1a.85.85 0 0 1 1.64-.43 4.6 4.6 0 1 0 .24-3.55h2.17a.85.85 0 0 1 0 1.7H3.96A.85.85 0 0 1 3.1 9V4.9a.85.85 0 0 1 1.7 0v2.3h-.6Z" fill="currentColor" />
  </svg>;
}

export function ArrowIcon({ className = "" }: IconProps): React.JSX.Element {
  return <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d="m7.7 4.8 5.2 5.2-5.2 5.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </svg>;
}
