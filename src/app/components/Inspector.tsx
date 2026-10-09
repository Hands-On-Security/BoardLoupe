import { BookmarkPlus, Copy, Crosshair, Eye, EyeOff, Focus, Layers, Wrench } from 'lucide-preact';
import { useMemo } from 'preact/hooks';
import { type SolderPoint, solderPoints } from '../../model/solder';
import { type BoardModel, MOUNT_UNKNOWN, NETFLAG_GROUND, NETFLAG_NOCONNECT, NETFLAG_POWER, NO_PROBE, PINKIND_TESTPOINT, mountLabel, sideLabel } from '../../model/types';
import { RATSNEST_MAX_PINS } from '../../scene/ratsnest';
import { collator } from '../../search/search';
import { addSelectionToGroup, copyText, focusSelection, selectNet, selectPart, selectPin, selectVia } from '../actions';
import { formatCoord, formatLength, plural } from '../format';
import { type LoadedBoard, store, useStore } from '../store';
import { Badge, Field, IconButton, SectionTitle, Unavailable, cx } from './ui';
import { VirtualList } from './VirtualList';

const SHAPES = ['default', 'circle', 'rectangle', 'rounded rect', 'oblong'];

function NetLink({ m, n }: { m: BoardModel; n: number }) {
  if (n < 0) return <Unavailable>no net</Unavailable>;
  const f = m.nets.flags[n];
  return (
    <button class="font-mono text-[12px] text-net hover:underline text-left break-all" onClick={() => selectNet(n)} title="Highlight net">
      {m.nets.name[n] || '(unnamed net)'}
      {f & NETFLAG_NOCONNECT ? <span class="text-faint"> (no-connect)</span> : null}
    </button>
  );
}

function PartLink({ m, k }: { m: BoardModel; k: number }) {
  if (k < 0) return <Unavailable>none (test point)</Unavailable>;
  return (
    <button class="font-mono text-[12px] text-part hover:underline" onClick={() => selectPart(k)}>
      {m.parts.name[k] || '(unnamed)'}
    </button>
  );
}

function Header({ kind, title, onCopy, badges }: { kind: string; title: string; onCopy: () => void; badges?: preact.ComponentChildren }) {
  return (
    <div class="px-3 pt-3 pb-2 border-b border-line">
      <div class="text-[10.5px] uppercase tracking-wider text-faint font-semibold">{kind}</div>
      <div class="flex items-center gap-1">
        <h2 class="text-[18px] font-semibold font-mono text-fg truncate flex-1" title={title}>
          {title}
        </h2>
        <IconButton label="Copy name" size="sm" onClick={onCopy}>
          <Copy size={14} />
        </IconButton>
        <IconButton label="Focus" shortcut="Z" size="sm" onClick={focusSelection}>
          <Focus size={14} />
        </IconButton>
      </div>
      {badges && <div class="flex flex-wrap gap-1 mt-1">{badges}</div>}
    </div>
  );
}

export function Inspector() {
  const board = useStore(store, (s) => s.board);
  const sel = useStore(store, (s) => s.sel);
  const isolate = useStore(store, (s) => s.isolate);
  const hideOther = useStore(store, (s) => s.hideOtherNets);
  if (!board) return <aside class="w-[320px] shrink-0 border-l border-line bg-panel" aria-label="Inspector" />;
  const m = board.model;
  let body: preact.ComponentChildren;
  if (sel.kind === 'part') body = <PartDetails b={board} k={sel.index} />;
  else if (sel.kind === 'pin') body = <PinDetails b={board} i={sel.index} />;
  else if (sel.kind === 'net') body = <NetDetails b={board} n={sel.index} />;
  else if (sel.kind === 'via') body = <ViaDetails b={board} i={sel.index} />;
  else if (sel.multi.length || sel.nets.length) body = null;
  else
    body = (
      <div class="p-5 text-center text-[12.5px] text-faint">
        <Crosshair size={22} class="mx-auto mb-2 opacity-60" />
        Nothing selected.
        <br />
        Click a part, pin or via on the board, or search on the left.
      </div>
    );
  return (
    <aside class="w-[320px] shrink-0 border-l border-line bg-panel flex flex-col min-h-0" aria-label="Inspector" data-testid="inspector">
      <div class="flex-1 min-h-0 overflow-auto scroll-thin">{body}</div>
      {(sel.multi.length > 0 || sel.nets.length > 0) && (
        <div class="border-t border-line max-h-[40%] overflow-auto scroll-thin">
          <SectionTitle>Multi-selection</SectionTitle>
          <div class="px-3 pb-3 flex flex-wrap gap-1">
            {sel.multi.map((k) => (
              <button key={k} class="h-6 px-2 rounded border border-line2 font-mono text-[11.5px] text-part hover:bg-raised" onClick={() => selectPart(k)}>
                {m.parts.name[k]}
              </button>
            ))}
            {sel.nets.map((n) => (
              <button key={'n' + n} class="h-6 px-2 rounded border border-line2 font-mono text-[11.5px] text-net hover:bg-raised" onClick={() => selectNet(n)}>
                {m.nets.name[n]}
              </button>
            ))}
          </div>
        </div>
      )}
      {sel.kind !== 'none' || sel.multi.length || sel.nets.length ? (
        <div class="border-t border-line p-2 flex gap-1 shrink-0">
          <button
            class={cx('flex-1 h-8 rounded-md text-[12px] font-medium flex items-center justify-center gap-1.5 border', isolate ? 'bg-accent-soft border-accent/50 text-accent' : 'border-line2 text-muted hover:text-fg hover:bg-raised')}
            onClick={() => store.set({ isolate: !isolate })}
            aria-pressed={isolate}
            title="Dim everything except the selection (I)"
          >
            <Layers size={14} /> Isolate
          </button>
          <button
            class={cx('flex-1 h-8 rounded-md text-[12px] font-medium flex items-center justify-center gap-1.5 border', hideOther ? 'bg-accent-soft border-accent/50 text-accent' : 'border-line2 text-muted hover:text-fg hover:bg-raised')}
            onClick={() => store.set({ hideOtherNets: !hideOther })}
            aria-pressed={hideOther}
            title="Hide pins of all other nets (H)"
          >
            {hideOther ? <EyeOff size={14} /> : <Eye size={14} />} Other nets
          </button>
          <button
            class="flex-1 h-8 rounded-md text-[12px] font-medium flex items-center justify-center gap-1.5 border border-line2 text-muted hover:text-fg hover:bg-raised"
            onClick={addSelectionToGroup}
            title="Keep the selection highlighted in the highlight group (A)"
          >
            <BookmarkPlus size={14} /> Group
          </button>
        </div>
      ) : null}
    </aside>
  );
}

function PinTable({ m, from, count, onPick }: { m: BoardModel; from: number; count: number; onPick: (i: number) => void }) {
  const idx = useMemo(() => {
    const a = Array.from({ length: count }, (_, i) => from + i);
    a.sort((x, y) => collator.compare(m.pins.number[x], m.pins.number[y]));
    return a;
  }, [m, from, count]);
  return (
    <VirtualList
      class="h-[min(360px,40vh)] mx-2 mb-2 rounded-md border border-line"
      count={idx.length}
      rowHeight={26}
      label="Pins"
      render={(r) => {
        const i = idx[r];
        const n = m.pins.net[i];
        return (
          <div class={cx('h-full flex items-center gap-2 px-2 text-[12px]', r % 2 ? 'bg-panel2/60' : '')}>
            <button class="w-12 font-mono text-info hover:underline text-left truncate" onClick={() => onPick(i)} title="Select pin">
              {m.pins.number[i] || '·'}
            </button>
            {m.caps.pinNames && <span class="w-16 font-mono text-faint truncate">{m.pins.name[i] || ''}</span>}
            <span class="flex-1 min-w-0 truncate">{n >= 0 ? <NetLink m={m} n={n} /> : <Unavailable>no net</Unavailable>}</span>
          </div>
        );
      }}
    />
  );
}

function PartDetails({ b, k }: { b: LoadedBoard; k: number }) {
  const m = b.model;
  const u = m.units;
  const bx = [m.parts.bbox[4 * k], m.parts.bbox[4 * k + 1], m.parts.bbox[4 * k + 2], m.parts.bbox[4 * k + 3]];
  const related = useMemo(() => {
    // Parts sharing signal nets (ground/power/no-connect excluded), by shared count.
    const count = new Map<number, number>();
    const seen = new Set<number>();
    for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) {
      const n = m.pins.net[j];
      if (n < 0 || seen.has(n) || m.nets.flags[n] & (NETFLAG_GROUND | NETFLAG_POWER | NETFLAG_NOCONNECT)) continue;
      seen.add(n);
      if (m.nets.pinStart[n + 1] - m.nets.pinStart[n] > 400) continue;
      const touched = new Set<number>();
      for (let q = m.nets.pinStart[n]; q < m.nets.pinStart[n + 1]; q++) {
        const o = m.pins.part[m.nets.pinIndex[q]];
        if (o >= 0 && o !== k) touched.add(o);
      }
      for (const o of touched) count.set(o, (count.get(o) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, c) => c[1] - a[1] || collator.compare(m.parts.name[a[0]], m.parts.name[c[0]])).slice(0, 24);
  }, [m, k]);
  return (
    <div>
      <Header
        kind="Component"
        title={m.parts.name[k] || '(unnamed)'}
        onCopy={() => copyText(m.parts.name[k])}
        badges={
          <>
            <Badge tone={m.parts.side[k] === 2 ? 'info' : 'neutral'}>{sideLabel(m.parts.side[k])}</Badge>
            {m.parts.mount[k] !== MOUNT_UNKNOWN && <Badge>{mountLabel(m.parts.mount[k])}</Badge>}
            <Badge>{plural(m.parts.pinCount[k], 'pin')}</Badge>
          </>
        }
      />
      <dl class="py-1.5">
        <Field label="Value">{m.parts.value[k] ?? <Unavailable />}</Field>
        <Field label="Footprint">{m.parts.footprint[k] ?? <Unavailable />}</Field>
        <Field label="Position" mono>
          {formatCoord(m.parts.x[k], m.parts.y[k], u)}
          {!m.parts.originFromFile[k] && <span class="text-faint font-sans"> (box centre)</span>}
        </Field>
        <Field label="Rotation">{Number.isNaN(m.parts.rot[k]) ? <Unavailable /> : `${m.parts.rot[k]}°`}</Field>
        <Field label="Size">
          {Number.isFinite(bx[0]) ? `${formatLength(bx[2] - bx[0], u, true)} × ${formatLength(bx[3] - bx[1], u, true)}` : <Unavailable />}
          {Number.isFinite(bx[0]) && <span class="text-faint"> {m.parts.bodyStart[k + 1] > m.parts.bodyStart[k] ? '(body outline from file)' : m.parts.bboxFromFile[k] ? '(from file)' : '(pin extent)'}</span>}
        </Field>
        {(m.parts.attrs[k] ?? []).map(([a, v]) => (
          <Field key={a} label={a}>
            {v}
          </Field>
        ))}
      </dl>
      <SectionTitle>Pins</SectionTitle>
      <PinTable m={m} from={m.parts.pinStart[k]} count={m.parts.pinCount[k]} onPick={(i) => selectPin(i)} />
      {related.length > 0 && (
        <>
          <SectionTitle>Connected parts (signal nets)</SectionTitle>
          <div class="px-3 pb-3 flex flex-wrap gap-1">
            {related.map(([o, c]) => (
              <button key={o} class="h-6 px-2 rounded border border-line2 font-mono text-[11.5px] text-part hover:bg-raised" onClick={() => selectPart(o)} title={`${c} shared net(s)`}>
                {m.parts.name[o]}
                <span class="text-faint ml-1">{c}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PinDetails({ b, i }: { b: LoadedBoard; i: number }) {
  const m = b.model;
  const s = b.scene;
  const k = m.pins.part[i];
  const n = m.pins.net[i];
  const title = k >= 0 ? `${m.parts.name[k]}.${m.pins.number[i] || '?'}` : `TP ${m.pins.number[i] || i}`;
  return (
    <div>
      <Header
        kind={m.pins.kind[i] === PINKIND_TESTPOINT ? 'Test point' : 'Pin'}
        title={title}
        onCopy={() => copyText(title)}
        badges={
          <>
            <Badge tone={m.pins.side[i] === 2 ? 'info' : 'neutral'}>{sideLabel(m.pins.side[i])}</Badge>
            {m.pins.hole[i] > 0 && <Badge>Drilled</Badge>}
          </>
        }
      />
      <dl class="py-1.5">
        <Field label="Component">
          <PartLink m={m} k={k} />
        </Field>
        <Field label="Number" mono>
          {m.pins.number[i] || <Unavailable />}
        </Field>
        <Field label="Name" mono>
          {m.pins.name[i] || <Unavailable />}
        </Field>
        <Field label="Net">
          <NetLink m={m} n={n} />
        </Field>
        <Field label="Position" mono>
          {formatCoord(m.pins.x[i], m.pins.y[i], m.units)}
        </Field>
        <Field label="Pad">
          {s.pinSizeFromFile[i] ? (
            `${SHAPES[m.pins.shape[i]] ?? 'pad'} ${formatLength(m.pins.w[i], m.units, true)} × ${formatLength(m.pins.h[i], m.units, true)}`
          ) : (
            <Unavailable>size not in file (drawn from spacing)</Unavailable>
          )}
        </Field>
        {m.pins.hole[i] > 0 && <Field label="Drill">{formatLength(m.pins.hole[i], m.units, true)}</Field>}
        {m.pins.probe[i] !== NO_PROBE && <Field label="Probe">{m.pins.probe[i]}</Field>}
      </dl>
      {n >= 0 && !(m.nets.flags[n] & NETFLAG_NOCONNECT) && <SolderPoints b={b} n={n} exclude={i} max={8} />}
      {n >= 0 && (
        <>
          <SectionTitle>Net members</SectionTitle>
          <NetMembers m={m} n={n} current={i} />
        </>
      )}
    </div>
  );
}

function reasonVar(reasons: string[]): string {
  if (reasons.includes('test point')) return 'var(--ok)';
  if (reasons.includes('through-hole') || reasons.includes('connector')) return 'var(--info)';
  if (reasons.includes('passive terminal') || reasons.includes('large pad')) return 'var(--accent)';
  if (reasons.includes('fine pitch')) return 'var(--faint)';
  return 'var(--muted)';
}

/**
 * Ranked, clickable list of the easiest points to tap a wire onto for this net
 * — test points first, then through-holes, connectors and large pads, with
 * fine-pitch IC pads last. The teaching workflow: reach a bus somewhere
 * accessible instead of on a BGA ball.
 */
function SolderPoints({ b, n, exclude = -1, max = 14 }: { b: LoadedBoard; n: number; exclude?: number; max?: number }) {
  const m = b.model;
  const s = b.scene;
  const pts = useMemo(() => solderPoints(m, s.pinHW, s.pinHH, s.typicalPin, n, 60), [m, s, n]);
  const list = pts.filter((p: SolderPoint) => !(p.kind === 'pin' && p.index === exclude));
  if (!list.length) return null;
  const go = (p: SolderPoint) => (p.kind === 'via' ? selectVia(p.index) : selectPin(p.index));
  return (
    <>
      <SectionTitle right={<span class="text-[10px] text-faint normal-case tracking-normal font-normal">easiest first</span>}>
        <span class="inline-flex items-center gap-1.5">
          <Wrench size={12} /> Solder / probe points
        </span>
      </SectionTitle>
      <div class="px-1.5 pb-2">
        {list.slice(0, max).map((p) => {
          const col = reasonVar(p.reasons);
          return (
            <button
              key={p.kind + p.index}
              class="w-full flex items-center gap-2 px-2 h-7 rounded-md hover:bg-raised text-left"
              onClick={() => go(p)}
              title={`${p.reasons.join(', ')} · score ${p.score}`}
            >
              <span class="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: col }} />
              <span class="font-mono text-[12px] text-fg w-28 truncate">{p.label}</span>
              <span class="flex-1 min-w-0 truncate text-[11px]" style={{ color: col }}>
                {p.reasons[0]}
              </span>
              <span class={cx('text-[10px] w-4 text-center shrink-0', p.side === 2 ? 'text-info' : 'text-faint')} title={sideLabel(p.side)}>
                {p.side === 2 ? 'B' : p.side === 1 ? 'T' : '±'}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function NetMembers({ m, n, current = -1 }: { m: BoardModel; n: number; current?: number }) {
  const idx = useMemo(() => {
    const a = Array.from(m.nets.pinIndex.subarray(m.nets.pinStart[n], m.nets.pinStart[n + 1]));
    a.sort((x, y) => collator.compare(m.parts.name[m.pins.part[x]] ?? '~', m.parts.name[m.pins.part[y]] ?? '~') || collator.compare(m.pins.number[x], m.pins.number[y]));
    return a;
  }, [m, n]);
  return (
    <VirtualList
      class="h-[min(420px,45vh)] mx-2 mb-2 rounded-md border border-line"
      count={idx.length}
      rowHeight={26}
      label="Net members"
      render={(r) => {
        const i = idx[r];
        const k = m.pins.part[i];
        return (
          <button
            class={cx('w-full h-full flex items-center gap-2 px-2 text-[12px] text-left', i === current ? 'bg-accent-soft' : r % 2 ? 'bg-panel2/60 hover:bg-raised' : 'hover:bg-raised')}
            onClick={() => selectPin(i)}
          >
            <span class="w-24 font-mono text-part truncate">{k >= 0 ? m.parts.name[k] : 'test point'}</span>
            <span class="w-14 font-mono text-info truncate">{m.pins.number[i]}</span>
            <span class="flex-1 text-faint text-[11px] truncate">{sideLabel(m.pins.side[i])}</span>
          </button>
        );
      }}
    />
  );
}

function NetDetails({ b, n }: { b: LoadedBoard; n: number }) {
  const m = b.model;
  const f = m.nets.flags[n];
  const count = m.nets.pinStart[n + 1] - m.nets.pinStart[n];
  const parts = useMemo(() => {
    const s = new Set<number>();
    for (let j = m.nets.pinStart[n]; j < m.nets.pinStart[n + 1]; j++) {
      const k = m.pins.part[m.nets.pinIndex[j]];
      if (k >= 0) s.add(k);
    }
    return [...s].sort((a, c) => collator.compare(m.parts.name[a], m.parts.name[c]));
  }, [m, n]);
  let vias = 0;
  for (let i = 0; i < m.vias.count; i++) if (m.vias.net[i] === n) vias++;
  const ratsOn = useStore(store, (s) => s.prefs.showRatsnest);
  return (
    <div>
      <Header
        kind="Net"
        title={m.nets.name[n] || '(unnamed net)'}
        onCopy={() => copyText(m.nets.name[n])}
        badges={
          <>
            {f & NETFLAG_GROUND ? <Badge tone="ok">ground</Badge> : null}
            {f & NETFLAG_POWER ? <Badge tone="err">power</Badge> : null}
            {f & NETFLAG_NOCONNECT ? <Badge tone="warn">no-connect marker</Badge> : null}
            <Badge>{plural(count, 'pin')}</Badge>
            <Badge>{plural(parts.length, 'part')}</Badge>
            {vias > 0 && <Badge>{plural(vias, 'via')}</Badge>}
          </>
        }
      />
      {f & NETFLAG_NOCONNECT ? (
        <p class="px-3 pt-2 text-[12px] text-warn">This name marks unconnected pins. Pins sharing it are not electrically connected.</p>
      ) : null}
      {ratsOn && count > RATSNEST_MAX_PINS && <p class="px-3 pt-2 text-[12px] text-faint">Air wires are not drawn for nets with more than {RATSNEST_MAX_PINS} pins.</p>}
      {!(f & NETFLAG_NOCONNECT) && <SolderPoints b={b} n={n} />}
      <SectionTitle>Parts on this net</SectionTitle>
      <div class="px-3 pb-2 flex flex-wrap gap-1 max-h-40 overflow-auto scroll-thin">
        {parts.slice(0, 400).map((k) => (
          <button key={k} class="h-6 px-2 rounded border border-line2 font-mono text-[11.5px] text-part hover:bg-raised" onClick={() => selectPart(k)}>
            {m.parts.name[k]}
          </button>
        ))}
        {parts.length > 400 && <span class="text-faint text-[11px]">+{parts.length - 400} more</span>}
      </div>
      <SectionTitle>Pins</SectionTitle>
      <NetMembers m={m} n={n} />
      <p class="px-3 pb-3 text-[11px] text-faint">
        Connectivity is taken from the net names in the file. {m.caps.traces ? 'Copper traces are available in the Layers menu.' : 'This file has no copper geometry; no traces are drawn.'}
      </p>
    </div>
  );
}

function ViaDetails({ b, i }: { b: LoadedBoard; i: number }) {
  const m = b.model;
  return (
    <div>
      <Header kind="Via / hole" title={`Via ${i + 1}`} onCopy={() => copyText(`${m.vias.x[i]}, ${m.vias.y[i]}`)} />
      <dl class="py-1.5">
        <Field label="Net">
          <NetLink m={m} n={m.vias.net[i]} />
        </Field>
        <Field label="Position" mono>
          {formatCoord(m.vias.x[i], m.vias.y[i], m.units)}
        </Field>
        <Field label="Diameter">{m.vias.d[i] > 0 ? formatLength(m.vias.d[i], m.units, true) : <Unavailable />}</Field>
      </dl>
    </div>
  );
}

