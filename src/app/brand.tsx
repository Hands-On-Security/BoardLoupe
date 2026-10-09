/**
 * Hands-On Security branding. BoardScope is published as a Hands-On Security
 * tool; the official logo is embedded as a data URI (see brand-logo.ts) so the
 * viewer stays a single offline file, and recoloured to white for the dark
 * theme via the .hos-logo CSS rule. The back-link points at a short URL they
 * manage.
 */
import type { JSX } from 'preact';
import { cx } from './components/ui';
import { HOS_LOGO } from './brand-logo';

/** Short URL (managed by Hands-On Security) → redirects to the project portal. */
export const HOS_URL = 'https://hos.direct/boardscope';
export const HOS_SITE = 'https://hands-on-security.com';
export const HOS_NAME = 'Hands-On Security';

/** The official Hands-On Security logo. Height drives the (proportional) width. */
export function HosLogo({ height = 20, class: cls }: { height?: number; class?: string }) {
  return <img src={HOS_LOGO} alt="Hands-On Security" class={cx('hos-logo', cls)} style={{ height: `${height}px`, width: 'auto' }} draggable={false} />;
}

/** Small "by Hands-On Security" link used in chrome; opens the project portal. */
export function HosByline({ height = 15, class: cls, ...rest }: JSX.HTMLAttributes<HTMLAnchorElement> & { height?: number }) {
  return (
    <a
      href={HOS_URL}
      target="_blank"
      rel="noopener noreferrer external"
      class={cx('inline-flex items-center gap-1.5 text-muted hover:opacity-80 transition-opacity', cls as string)}
      title="BoardScope is a Hands-On Security tool — open the project portal"
      {...rest}
    >
      <span class="text-[11.5px]">by</span>
      <HosLogo height={height} />
    </a>
  );
}
