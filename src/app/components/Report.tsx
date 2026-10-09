import { FileDown, ImageDown, Printer } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { downloadText, exportBaseName, highlightFor, viewer } from '../actions';
import { REPORT_IMAGE_ASPECT, type ReportImage, type ReportOptions, type ReportView, collectReport, renderReportHtml } from '../report';
import { store, toast, useStore } from '../store';
import { saveViewPng } from './Groups';
import { Button, Dialog, Kbd, Toggle } from './ui';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A4 at 96 CSS px per inch. */
const PAGE_W = 794;
const PAGE_H = 1123;

export function ReportDialog() {
  const board = useStore(store, (s) => s.board);
  const sel = useStore(store, (s) => s.sel);
  const group = useStore(store, (s) => s.group);
  const otherSide = useStore(store, (s) => s.prefs.otherSide);
  const close = () => store.set({ dialog: null });
  const [opts, setOpts] = useState<ReportOptions>({ title: '', notes: '', includeImage: true, lightImage: true, includeSolder: true, includeParts: true });
  // Preview options lag the inputs slightly so typing does not re-parse the document on every key.
  const [previewOpts, setPreviewOpts] = useState(opts);
  const [images, setImages] = useState<{ light?: ReportImage | null; dark?: ReportImage | null }>({});
  const frame = useRef<HTMLIFrameElement>(null);
  const printPending = useRef(false);

  // Capture the current view once per palette (the view under the dialog does not change).
  const key = opts.lightImage ? 'light' : 'dark';
  useEffect(() => {
    if (!opts.includeImage || images[key] !== undefined) return;
    // Same centre and zoom as on screen, extended to fill the report's frame.
    const img = viewer.captureImage({ light: opts.lightImage, aspect: REPORT_IMAGE_ASPECT });
    setImages((prev) => ({ ...prev, [key]: img }));
  }, [key, opts.includeImage]);

  useEffect(() => {
    const t = setTimeout(() => setPreviewOpts(opts), 250);
    return () => clearTimeout(t);
  }, [opts]);

  const build = (o: ReportOptions) => {
    if (!board) return '';
    const m = board.model;
    const h = highlightFor(sel, m, false, false, group);
    const v: ReportView = {
      side: viewer.opts.side,
      mirror: viewer.view.mirror,
      rot: viewer.view.rot,
      zoomPct: Math.round((viewer.view.scale / (viewer.fitScale || 1)) * 100),
      otherSide,
    };
    const img = (o.lightImage ? images.light : images.dark) ?? null;
    return renderReportHtml(collectReport(m, board.scene, h, group.nets, v, o, img));
  };
  const html = useMemo(() => build(previewOpts), [board, sel, group, previewOpts, images, otherSide]);

  const print = () => {
    const f = frame.current;
    if (!f || f.offsetParent === null) {
      // Preview hidden (narrow window): print from a temporary off-screen frame.
      const tmp = document.createElement('iframe');
      tmp.setAttribute('sandbox', 'allow-same-origin allow-modals');
      tmp.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
      tmp.onload = () => {
        try {
          tmp.contentWindow?.print();
        } catch {
          toast('Printing is blocked here — use “Download HTML” and print it from the browser');
        }
        setTimeout(() => tmp.remove(), 60_000);
      };
      tmp.srcdoc = build(opts);
      document.body.appendChild(tmp);
      return;
    }
    const w = f.contentWindow;
    if (previewOpts !== opts) {
      // Show the latest edits first, then print once the frame has reloaded.
      printPending.current = true;
      setPreviewOpts(opts);
      return;
    }
    if (!w) return;
    try {
      w.focus();
      w.print();
    } catch {
      toast('Printing is blocked here — use “Download HTML” and print it from the browser');
    }
  };

  useEffect(() => {
    const onPrint = () => print();
    window.addEventListener('bs-report-print', onPrint);
    return () => window.removeEventListener('bs-report-print', onPrint);
  });

  if (!board) return null;
  const m = board.model;
  const h = highlightFor(sel, m, false, false, group);
  const set = (p: Partial<ReportOptions>) => setOpts((o) => ({ ...o, ...p }));
  const scale = 0.54;

  return (
    <Dialog title="Report" onClose={close} wide icon={<Printer size={16} class="text-accent" />}>
      <div class="h-full grid md:grid-cols-[minmax(280px,1fr)_auto] gap-5 p-4 min-h-0">
        <div class="flex flex-col gap-3 min-w-0">
          <p class="text-[12.5px] text-muted leading-relaxed">
            An A4 report of the current view with board details, the {h.nets.length ? <strong class="text-fg">{h.nets.length} highlighted net{h.nets.length !== 1 ? 's' : ''}</strong> : 'highlighted nets'}
            {group.nets.length ? ` (${group.nets.length} from the highlight group)` : ''} and their best solder / probe points. Use <em>Save as PDF</em> in the print dialog.
          </p>
          {!h.nets.length && <p class="text-[12px] text-warn">No nets are highlighted. Select nets or build a highlight group (Groups tab) to list them in the report.</p>}
          <label class="block text-[12.5px]">
            Title
            <input
              class="mt-1 w-full h-8 rounded-md bg-panel2 border border-line2 px-2 text-[13px] outline-none focus:border-accent"
              placeholder={`${m.source.fileName} — board analysis`}
              value={opts.title}
              maxLength={140}
              onInput={(e) => set({ title: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="block text-[12.5px]">
            Notes <span class="text-faint">(optional)</span>
            <textarea
              class="mt-1 w-full h-24 rounded-md bg-panel2 border border-line2 p-2 text-[12.5px] outline-none focus:border-accent resize-y"
              placeholder="e.g. TPM on the SPI bus — tap SPI_CLK/MOSI/MISO/CS at the test points listed below."
              value={opts.notes}
              maxLength={4000}
              onInput={(e) => set({ notes: (e.target as HTMLTextAreaElement).value })}
            />
          </label>
          <div>
            <Toggle label="Board view image" hint="The current view as you see it, at print resolution" checked={opts.includeImage} onChange={(v) => set({ includeImage: v })} />
            {opts.includeImage && <Toggle label="Print-friendly (light) image" hint="Light background; off keeps the on-screen colours" checked={opts.lightImage} onChange={(v) => set({ lightImage: v })} />}
            <Toggle label="Solder / probe points per net" checked={opts.includeSolder} onChange={(v) => set({ includeSolder: v })} />
            <Toggle label="Highlighted parts" checked={opts.includeParts} onChange={(v) => set({ includeParts: v })} />
          </div>
          <div class="flex flex-wrap gap-2 pt-1 mt-auto">
            <Button variant="solid" onClick={print} title="Opens the print dialog — choose “Save as PDF”">
              <Printer size={14} /> Print / Save as PDF <Kbd>{IS_MAC ? '⌘P' : 'Ctrl+P'}</Kbd>
            </Button>
            <Button onClick={() => downloadText(`${exportBaseName(m)}-report.html`, build(opts), 'text/html')} title="Self-contained HTML; open it in any browser and print">
              <FileDown size={14} /> Download HTML
            </Button>
            <Button variant="ghost" onClick={saveViewPng}>
              <ImageDown size={14} /> View as PNG
            </Button>
          </div>
        </div>
        <div class="hidden md:block">
          <div class="text-[11px] uppercase tracking-wider text-faint font-semibold mb-1.5">Preview (A4)</div>
          <div class="rounded-md border border-line2 overflow-hidden bg-[#e7e7ec]" style={{ width: PAGE_W * scale, height: PAGE_H * scale }}>
            <iframe
              ref={frame}
              title="Report preview"
              data-testid="report-preview"
              srcDoc={html}
              sandbox="allow-same-origin allow-modals"
              style={{ width: PAGE_W, height: PAGE_H, border: 0, transform: `scale(${scale})`, transformOrigin: '0 0', background: '#fff' }}
              onLoad={() => {
                if (printPending.current) {
                  printPending.current = false;
                  print();
                }
              }}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
