interface LoadingDotsProps {
  /** Tailwind size class applied to each dot. Defaults to `size-1`. */
  size?: string;
  /** Tailwind background colour class applied to each dot. Defaults to current text colour. */
  color?: string;
  className?: string;
}

export function LoadingDots({
  size = 'size-1',
  color = 'bg-current',
  className = '',
}: LoadingDotsProps): JSX.Element {
  // Three opacity-pulsing dots, staggered by 200ms so they "light up" in
  // sequence. `animate-pulse` is opacity-only — visually identical to the
  // typing-indicator pattern users expect for "thinking" states.
  const dot = `${size} ${color} rounded-full animate-pulse`;
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} aria-hidden="true">
      <span className={`${dot} [animation-delay:0ms]`} />
      <span className={`${dot} [animation-delay:200ms]`} />
      <span className={`${dot} [animation-delay:400ms]`} />
    </span>
  );
}
