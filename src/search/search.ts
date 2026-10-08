import type { BoardModel } from '../model/types';

export type HitKind = 'part' | 'net' | 'pin';

export interface SearchHit {
  kind: HitKind;
  index: number;
  score: number;
  /** Primary text (refdes, net name, "U1.17"). */
  label: string;
  /** Secondary text (value, pin count, net …). */
  detail: string;
  /** Which field matched when not the label. */
  via?: string;
}

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const REFDES_RE = /^[a-z]{1,4}\d+[a-z]?$/i;
const BOUNDARY = /[_\-./+\s:()[\]]/;

/** Subsequence match score in (0, 1], or 0 when q is not a subsequence of s. */
export function fuzzyScore(q: string, s: string): number {
  if (q.length > s.length) return 0;
  let qi = 0,
    gaps = 0,
    last = -1,
    bonus = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      if (last >= 0 && si !== last + 1) gaps += si - last - 1;
      if (si === 0 || BOUNDARY.test(s[si - 1])) bonus += 1;
      last = si;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  return Math.max(0.05, 1 - gaps / (s.length + 1)) * (0.7 + (0.3 * bonus) / q.length);
}

function textScore(q: string, s: string): number {
  if (!s) return 0;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 800 - Math.min(100, s.length - q.length);
  const at = s.indexOf(q);
  if (at > 0) return (BOUNDARY.test(s[at - 1]) ? 650 : 520) - Math.min(100, at);
  return 0;
}

/**
 * In-memory index over parts, nets and pins. Lower-cased name arrays are
 * built once per board; queries are a linear scan (a few ms for 50k names)
 * with exact/prefix/substring/fuzzy ranking, debounced by the UI.
 */
export class SearchIndex {
  private partLc: string[];
  private netLc: string[];
  private valueLc: string[];
  private partByName = new Map<string, number[]>();

  constructor(private m: BoardModel) {
    this.partLc = m.parts.name.map((s) => s.toLowerCase());
    this.netLc = m.nets.name.map((s) => s.toLowerCase());
    this.valueLc = m.parts.value.map((v, i) => [v ?? '', m.parts.footprint[i] ?? '', ...(m.parts.attrs[i] ?? []).map((a) => a[1])].join('\u0001').toLowerCase());
    this.partLc.forEach((n, i) => {
      const l = this.partByName.get(n);
      if (l) l.push(i);
      else this.partByName.set(n, [i]);
    });
  }

  partsNamed(name: string): number[] {
    return this.partByName.get(name.toLowerCase()) ?? [];
  }

  netDetail(n: number): string {
    const c = this.m.nets.pinStart[n + 1] - this.m.nets.pinStart[n];
    return `${c} pin${c === 1 ? '' : 's'}`;
  }

  partDetail(k: number): string {
    const m = this.m;
    const v = m.parts.value[k] || m.parts.footprint[k] || '';
    const c = m.parts.pinCount[k];
    return `${c} pin${c === 1 ? '' : 's'}${v ? ' · ' + v : ''}`;
  }

  pinLabel(i: number): string {
    const m = this.m;
    const k = m.pins.part[i];
    const pn = m.pins.number[i] || m.pins.name[i] || '?';
    return k >= 0 ? `${m.parts.name[k]}.${pn}` : `TP ${pn}`;
  }

  pinDetail(i: number): string {
    const m = this.m;
    const n = m.pins.net[i];
    return n >= 0 ? m.nets.name[n] || '(unnamed net)' : 'no net';
  }

  query(raw: string, limit = 150, contextPart = -1): SearchHit[] {
    const q = raw.trim().toLowerCase();
    if (!q) return [];
    const m = this.m;
    const hits: SearchHit[] = [];

    // "pin 17" / "#17": pins by number, current part first.
    const pinOnly = /^(?:pin\s+|#)(\S+)$/.exec(q);
    if (pinOnly) {
      const want = pinOnly[1];
      const add = (i: number, score: number) => hits.push({ kind: 'pin', index: i, score, label: this.pinLabel(i), detail: this.pinDetail(i) });
      if (contextPart >= 0) {
        for (let j = m.parts.pinStart[contextPart]; j < m.parts.pinStart[contextPart] + m.parts.pinCount[contextPart]; j++) {
          if (m.pins.number[j].toLowerCase() === want || m.pins.name[j].toLowerCase() === want) add(j, 2000);
        }
      }
      for (let i = 0; i < m.pins.count && hits.length < limit; i++) {
        if (m.pins.part[i] === contextPart) continue;
        if (m.pins.number[i].toLowerCase() === want || m.pins.name[i].toLowerCase() === want) add(i, 900);
      }
      return hits.slice(0, limit);
    }

    // "U42.17", "U42:17", "U42 17", "U42 pin 17", "U42-A3" where U42 is a real part.
    const pinRef = /^(.+?)(?:[.:\s]+(?:pin\s*)?|-)(\S+)$/.exec(q);
    if (pinRef) {
      const parts = this.partByName.get(pinRef[1]);
      if (parts) {
        const want = pinRef[2];
        for (const k of parts) {
          for (let j = m.parts.pinStart[k]; j < m.parts.pinStart[k] + m.parts.pinCount[k]; j++) {
            const num = m.pins.number[j].toLowerCase(),
              nm = m.pins.name[j].toLowerCase();
            const sc = num === want || nm === want ? 3000 : num.startsWith(want) || nm.startsWith(want) ? 1500 : 0;
            if (sc) hits.push({ kind: 'pin', index: j, score: sc, label: this.pinLabel(j), detail: this.pinDetail(j) });
          }
        }
      }
    }

    const refLike = REFDES_RE.test(q);
    const partBias = refLike ? 15 : -5;
    for (let k = 0; k < this.partLc.length; k++) {
      let s = textScore(q, this.partLc[k]);
      let via: string | undefined;
      if (!s) {
        const v = this.valueLc[k];
        if (v && v.includes(q)) {
          s = 300;
          via = 'value';
        }
      }
      if (s) hits.push({ kind: 'part', index: k, score: s + partBias, label: m.parts.name[k] || '(unnamed part)', detail: this.partDetail(k), via });
    }
    for (let n = 0; n < this.netLc.length; n++) {
      const s = textScore(q, this.netLc[n]);
      if (s) hits.push({ kind: 'net', index: n, score: s - partBias, label: m.nets.name[n], detail: this.netDetail(n) });
    }
    // Fuzzy fallback when direct matches are scarce.
    if (hits.length < 20 && q.length >= 2) {
      const seen = new Set(hits.map((h) => `${h.kind}${h.index}`));
      for (let k = 0; k < this.partLc.length; k++) {
        if (seen.has(`part${k}`)) continue;
        const f = fuzzyScore(q, this.partLc[k]);
        if (f > 0.35) hits.push({ kind: 'part', index: k, score: 100 + 200 * f, label: m.parts.name[k], detail: this.partDetail(k), via: 'fuzzy' });
      }
      for (let n = 0; n < this.netLc.length; n++) {
        if (seen.has(`net${n}`)) continue;
        const f = fuzzyScore(q, this.netLc[n]);
        if (f > 0.35) hits.push({ kind: 'net', index: n, score: 100 + 200 * f, label: m.nets.name[n], detail: this.netDetail(n), via: 'fuzzy' });
      }
    }
    hits.sort((a, b) => b.score - a.score || collator.compare(a.label, b.label));
    return hits.slice(0, limit);
  }
}
