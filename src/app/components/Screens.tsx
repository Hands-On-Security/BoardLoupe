import { AlertTriangle, CircuitBoard, FolderOpen, KeyRound, Loader2, ShieldCheck, Upload, X } from 'lucide-preact';
import { FORMATS } from '../../formats/registry';
import { cancelLoad } from '../actions';
import { HOS_URL, HosLogo } from '../brand';
import { store, useStore } from '../store';
import { openPicker } from './Toolbar';
import { Badge, Button, Kbd } from './ui';

const STATUS_TONE = { verified: 'ok', partial: 'warn', experimental: 'warn', diagnostic: 'neutral' } as const;
const STATUS_TEXT = { verified: 'verified', partial: 'partial', experimental: 'experimental', diagnostic: 'detected only' } as const;

export function EmptyState({ dragging }: { dragging: boolean }) {
  const formats = FORMATS.filter((f) => f.status !== 'diagnostic');
  return (
    <div class="absolute inset-0 overflow-auto scroll-thin flex items-start md:items-center justify-center p-6">
      <div class="w-full max-w-[860px] fade-in">
        <div class="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 rounded-xl bg-accent-soft flex items-center justify-center">
              <CircuitBoard size={24} class="text-accent" />
            </div>
            <div>
              <h1 class="text-[22px] font-semibold tracking-tight">BoardScope</h1>
              <p class="text-muted text-[13px]">Offline boardview viewer — identify components, trace nets, find solder points</p>
            </div>
          </div>
          <a
            href={HOS_URL}
            target="_blank"
            rel="noopener noreferrer external"
            class="flex flex-col items-start gap-1.5 rounded-xl border border-line2 px-3.5 py-2.5 hover:bg-raised transition-colors"
            title="BoardScope is a Hands-On Security tool — open the project portal"
          >
            <HosLogo height={26} />
            <span class="text-[10.5px] text-faint">Practical hardware security training</span>
          </a>
        </div>
        <div
          class={`dropzone-dash rounded-2xl ${dragging ? 'dropzone-active' : 'bg-panel/60'} transition-colors px-6 py-10 flex flex-col items-center text-center`}
          data-testid="dropzone"
        >
          <Upload size={30} class={dragging ? 'text-accent' : 'text-faint'} />
          <p class="mt-3 text-[16px] font-medium">{dragging ? 'Drop to open' : 'Drop a boardview file here'}</p>
          <p class="text-muted text-[13px] mt-1">or a ZIP containing one · several ASC files at once</p>
          <div class="mt-5 flex items-center gap-3">
            <Button variant="solid" onClick={openPicker}>
              <FolderOpen size={15} /> Browse files…
            </Button>
            <span class="text-faint text-[12px] flex items-center gap-1">
              <Kbd>Ctrl</Kbd>
              <Kbd>O</Kbd>
            </span>
          </div>
        </div>
        <div class="mt-6 grid md:grid-cols-[1fr_280px] gap-5">
          <section aria-labelledby="fmt-h">
            <h2 id="fmt-h" class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-2">
              Supported formats (detected by content, not extension)
            </h2>
            <ul class="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {formats.map((f) => (
                <li key={f.id} class="flex items-start gap-2 text-[12.5px]">
                  <Badge tone={STATUS_TONE[f.status]}>{STATUS_TEXT[f.status]}</Badge>
                  <span class="min-w-0">
                    <span class="text-fg">{f.name}</span>
                    <span class="text-faint"> · {f.extensions.map((e) => '.' + e).join(' ')}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p class="text-faint text-[11.5px] mt-2 flex items-start gap-1.5">
              <KeyRound size={12} class="mt-0.5 shrink-0" /> Encrypted FZ / CAE / XZZ files need a key you provide (Settings). No keys are bundled. Binary Allegro databases are recognised and explained, not opened.
            </p>
          </section>
          <section class="rounded-xl border border-line bg-panel p-4 h-fit" aria-labelledby="priv-h">
            <h2 id="priv-h" class="flex items-center gap-2 text-[13px] font-semibold text-ok">
              <ShieldCheck size={16} /> Private by design
            </h2>
            <ul class="mt-2 space-y-1.5 text-[12.5px] text-muted list-disc pl-4">
              <li>Files are read and parsed locally in your browser.</li>
              <li>No uploads, network requests, analytics or telemetry.</li>
              <li>Works fully offline from this single HTML file.</li>
              <li>Only display preferences are stored (in this browser).</li>
            </ul>
          </section>
        </div>
        <p class="mt-6 pt-4 border-t border-line text-[12px] text-faint flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="inline-flex items-center gap-1.5">
            A <HosLogo height={13} /> tool.
          </span>
          <span class="text-muted">Understand the attack. Build the skills to defend.</span>
        </p>
      </div>
    </div>
  );
}

export function LoadingOverlay() {
  const loading = useStore(store, (s) => s.loading);
  if (!loading) return null;
  const pct = loading.fraction !== undefined ? Math.round(loading.fraction * 100) : null;
  return (
    <div class="absolute inset-0 z-30 flex items-center justify-center bg-bg/60 backdrop-blur-[2px]" role="status" aria-live="polite" data-testid="loading">
      <div class="w-[360px] rounded-xl border border-line2 bg-panel shadow-pop p-5 fade-in">
        <div class="flex items-center gap-2.5">
          <Loader2 size={18} class="text-accent animate-spin" />
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium truncate">{loading.name}</div>
            <div class="text-[12px] text-muted truncate">{loading.phase}…</div>
          </div>
          <span class="text-[12px] text-faint tabular">{pct !== null ? `${pct}%` : ''}</span>
        </div>
        <div class="mt-3 h-1.5 rounded-full bg-line overflow-hidden">
          {pct !== null ? (
            <div class="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          ) : (
            <div class="h-full w-2/5 bg-accent rounded-full progress-indeterminate" />
          )}
        </div>
        <div class="mt-4 flex justify-end">
          <Button variant="ghost" onClick={cancelLoad}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ErrorView() {
  const error = useStore(store, (s) => s.error);
  const hasBoard = useStore(store, (s) => !!s.board);
  if (!error) return null;
  const main = error.diagnostics.find((d) => d.level === 'error') ?? error.diagnostics[0];
  const keyIssue = /key/i.test(main?.code ?? '');
  return (
    <div class={hasBoard ? 'absolute inset-0 z-40 flex items-center justify-center bg-black/40 p-4' : 'absolute inset-0 flex items-center justify-center p-6'}>
      <div class="w-full max-w-[600px] rounded-xl border border-err/40 bg-panel shadow-pop p-5 fade-in" role="alert" data-testid="error">
        <div class="flex items-start gap-3">
          <AlertTriangle size={20} class="text-err shrink-0 mt-0.5" />
          <div class="min-w-0 flex-1">
            <h2 class="text-[15px] font-semibold">Can’t open {error.name}</h2>
            <p class="mt-1.5 text-[13px] text-fg leading-relaxed" data-testid="error-message">
              {main?.message ?? 'Unknown error.'}
            </p>
            {main?.offset !== undefined && <p class="text-[12px] text-faint mt-1 font-mono">at byte offset 0x{main.offset.toString(16)}</p>}
            {error.diagnostics.length > 1 && (
              <details class="mt-3">
                <summary class="text-[12px] text-muted cursor-pointer select-none">Details ({error.diagnostics.length})</summary>
                <ul class="mt-2 space-y-1 text-[12px] text-muted">
                  {error.diagnostics.map((d, i) => (
                    <li key={i}>
                      <span class={d.level === 'error' ? 'text-err' : d.level === 'warning' ? 'text-warn' : 'text-info'}>{d.level}</span> — {d.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div class="mt-4 flex gap-2 flex-wrap">
              <Button variant="solid" onClick={openPicker}>
                <FolderOpen size={14} /> Open another file
              </Button>
              {keyIssue && (
                <Button onClick={() => store.set({ dialog: 'settings', error: null, phase: hasBoard ? 'ready' : 'empty' })}>
                  <KeyRound size={14} /> Enter key
                </Button>
              )}
              <Button variant="ghost" onClick={() => store.set({ error: null, phase: hasBoard ? 'ready' : 'empty' })}>
                <X size={14} /> Dismiss
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const t = useStore(store, (s) => s.toast);
  if (!t) return null;
  return (
    <div class="fixed bottom-10 left-1/2 -translate-x-1/2 z-[60] rounded-lg border border-line2 bg-raised shadow-pop px-3.5 py-2 text-[12.5px] fade-in" role="status" aria-live="polite">
      {t.text}
    </div>
  );
}
