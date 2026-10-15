import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ');
}

type BtnProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  children: ComponentChildren;
  variant?: 'ghost' | 'solid' | 'outline';
  size?: 'sm' | 'md';
};

/** Icon button: accessible name + native tooltip that includes the shortcut. */
export function IconButton({ active, label, shortcut, children, variant = 'ghost', size = 'md', class: cls, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={shortcut ? `${label} (${shortcut})` : label}
      class={cx(
        'inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none select-none shrink-0',
        size === 'md' ? 'h-8 w-8' : 'h-7 w-7',
        variant === 'ghost' && (active ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg hover:bg-raised'),
        variant === 'outline' && 'border border-line2 text-muted hover:text-fg hover:bg-raised',
        variant === 'solid' && 'bg-accent text-accent-fg hover:brightness-110',
        cls as string,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  variant = 'outline',
  class: cls,
  ...rest
}: JSX.HTMLAttributes<HTMLButtonElement> & { variant?: 'outline' | 'solid' | 'ghost'; disabled?: boolean; children: ComponentChildren }) {
  return (
    <button
      type="button"
      class={cx(
        'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium transition-colors disabled:opacity-40 select-none whitespace-nowrap',
        variant === 'solid' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'outline' && 'border border-line2 text-fg hover:bg-raised',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-raised',
        cls as string,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="inline-flex items-center h-5 min-w-5 px-1.5 rounded border border-line2 bg-panel2 text-[11px] font-mono text-muted">{children}</kbd>;
}

export function Badge({ children, tone = 'neutral', title }: { children: ComponentChildren; tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent'; title?: string }) {
  const tones: Record<string, string> = {
    neutral: 'bg-raised text-muted border-line2',
    ok: 'text-ok border-ok/40 bg-ok/10',
    warn: 'text-warn border-warn/40 bg-warn/10',
    err: 'text-err border-err/40 bg-err/10',
    info: 'text-info border-info/40 bg-info/10',
    accent: 'text-accent border-accent/40 bg-accent-soft',
  };
  return (
    <span title={title} class={cx('inline-flex items-center h-5 px-1.5 rounded border text-[11px] font-medium whitespace-nowrap', tones[tone])}>
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label class="flex items-start gap-2.5 py-1.5 cursor-pointer select-none group">
      <span class="relative mt-0.5">
        <input type="checkbox" class="peer sr-only" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        <span class="block w-7 h-4 rounded-full bg-line2 peer-checked:bg-accent transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-1" />
        <span class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-fg peer-checked:translate-x-3 peer-checked:bg-accent-fg transition-transform" />
      </span>
      <span class="flex flex-col">
        <span class="text-fg text-[13px]">{label}</span>
        {hint && <span class="text-faint text-[11.5px] leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

export function SectionTitle({ children, right }: { children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="flex items-center justify-between px-3 pt-3 pb-1.5">
      <h3 class="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</h3>
      {right}
    </div>
  );
}

export function Field({ label, children, mono }: { label: string; children: ComponentChildren; mono?: boolean }) {
  return (
    <div class="grid grid-cols-[104px_1fr] gap-2 px-3 py-1 text-[12.5px] items-baseline">
      <dt class="text-muted truncate">{label}</dt>
      <dd class={cx('text-fg break-words min-w-0', mono && 'font-mono text-[12px]')}>{children}</dd>
    </div>
  );
}

export function Unavailable({ children = 'not in file' }: { children?: ComponentChildren }) {
  return <span class="text-faint italic">{children}</span>;
}

/** Modal dialog with focus trap-lite (initial focus + Esc to close). */
export function Dialog({ title, onClose, children, wide, icon }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; icon?: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        class={cx('fade-in bg-panel border border-line2 rounded-xl shadow-pop flex flex-col max-h-[90vh] w-full outline-none', wide ? 'max-w-[1100px] h-[86vh]' : 'max-w-[620px]')}
      >
        <div class="flex items-center gap-2 h-12 px-4 border-b border-line shrink-0">
          {icon}
          <h2 class="text-[14px] font-semibold flex-1">{title}</h2>
          <IconButton label="Close" shortcut="Esc" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </div>
        <div class="flex-1 min-h-0 overflow-auto scroll-thin">{children}</div>
      </div>
    </div>
  );
}
