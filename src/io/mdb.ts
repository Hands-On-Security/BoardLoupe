/**
 * Minimal read-only Microsoft Jet database reader (Jet 3 .mdb and Jet 4),
 * enough to list tables and read their rows with fixed and variable-length
 * columns. Written from the published on-disk layout:
 *
 *   page 0          database definition; u32 Jet version at 0x14
 *   type 0x02 page  table definition (TDEF): column count, column records, names
 *   type 0x01 page  data page: owning TDEF page, row offset table, rows growing
 *                   down from the end of the page
 *   page 2          TDEF of MSysObjects (the catalog: Name, Type, Id → TDEF page)
 *
 * Rows: u16/u8 column count, fixed-length data, variable-length data, the
 * variable-column offset table (reversed), its count, then the null bitmap
 * (bit set = value present; for booleans the bit is the value).
 * Not supported: encrypted databases, long values stored outside the row
 * (memo/OLE on LVAL pages) — such cells read as null.
 */
import { ParseError } from './bytes';

export type Cell = string | number | boolean | null;

export interface MdbColumn {
  name: string;
  type: number;
  num: number;
  /** Index among variable-length columns. */
  varIndex: number;
  /** Offset of fixed-length data. */
  fixedOffset: number;
  len: number;
  fixed: boolean;
}

export const MDB_BOOL = 0x01,
  MDB_BYTE = 0x02,
  MDB_INT = 0x03,
  MDB_LONG = 0x04,
  MDB_MONEY = 0x05,
  MDB_FLOAT = 0x06,
  MDB_DOUBLE = 0x07,
  MDB_DATETIME = 0x08,
  MDB_BINARY = 0x09,
  MDB_TEXT = 0x0a,
  MDB_OLE = 0x0b,
  MDB_MEMO = 0x0c,
  MDB_GUID = 0x0f,
  MDB_NUMERIC = 0x10;

const FIXED_SIZE: Record<number, number> = { [MDB_BYTE]: 1, [MDB_INT]: 2, [MDB_LONG]: 4, [MDB_FLOAT]: 4, [MDB_DOUBLE]: 8, [MDB_DATETIME]: 8, [MDB_MONEY]: 8 };

interface Layout {
  pageSize: number;
  jet4: boolean;
}

export class MdbReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly pageSize: number;
  readonly jet4: boolean;
  readonly pages: number;
  private dataPagesByTdef: Map<number, number[]> | null = null;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 0x800 || !/^Standard (Jet|ACE) DB/.test(String.fromCharCode(...bytes.subarray(4, 19))))
      throw new ParseError('mdb.magic', 'Not a Microsoft Jet/Access database ("Standard Jet DB" missing at offset 4)');
    const version = this.view.getUint32(0x14, true);
    const l: Layout = version === 0 ? { pageSize: 2048, jet4: false } : { pageSize: 4096, jet4: true };
    this.pageSize = l.pageSize;
    this.jet4 = l.jet4;
    this.pages = Math.floor(bytes.length / l.pageSize);
    if (this.pages < 3) throw new ParseError('mdb.short', 'The database is too short to hold a catalog');
  }

  private page(n: number): number {
    if (n < 0 || n >= this.pages) throw new ParseError('mdb.page', `Page ${n} is outside the database (${this.pages} pages)`);
    return n * this.pageSize;
  }
  private check(o: number, n: number) {
    if (!(o >= 0 && o + n <= this.bytes.length)) throw new ParseError('mdb.bounds', `Damaged database: read of ${n} bytes at 0x${o.toString(16)} is outside the file`, { offset: o });
  }
  private u8 = (o: number) => {
    this.check(o, 1);
    return this.bytes[o];
  };
  private u16 = (o: number) => {
    this.check(o, 2);
    return this.view.getUint16(o, true);
  };
  private u32 = (o: number) => {
    this.check(o, 4);
    return this.view.getUint32(o, true);
  };

  /** Reads a table definition (possibly spread over continuation pages). */
  tableDef(tdefPage: number): { columns: MdbColumn[]; rowCount: number } {
    // Concatenate the TDEF chain: each page contributes its bytes after the 8-byte header.
    const parts: Uint8Array[] = [];
    let pg = tdefPage;
    for (let guard = 0; pg && guard < 64; guard++) {
      const o = this.page(pg);
      if (this.u8(o) !== 0x02) throw new ParseError('mdb.tdef', `Page ${pg} is not a table definition`, { offset: o });
      parts.push(guard === 0 ? this.bytes.subarray(o, o + this.pageSize) : this.bytes.subarray(o + 8, o + this.pageSize));
      pg = this.u32(o + 4);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const t = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      t.set(p, at);
      at += p.length;
    }
    const v = new DataView(t.buffer);
    const J4 = this.jet4;
    const rowCount = v.getUint32(J4 ? 16 : 12, true);
    const numCols = v.getUint16(J4 ? 45 : 25, true);
    const numRealIdx = v.getUint32(J4 ? 51 : 31, true);
    if (numRealIdx > 1000) throw new ParseError('mdb.tdef', `Implausible index count ${numRealIdx} in a table definition`);
    let p = (J4 ? 63 : 43) + numRealIdx * (J4 ? 12 : 8);
    const colSize = J4 ? 25 : 18;
    const columns: MdbColumn[] = [];
    for (let i = 0; i < numCols; i++, p += colSize) {
      if (p + colSize > t.length) throw new ParseError('mdb.tdef', 'Table definition is truncated');
      const type = t[p];
      const num = v.getUint16(p + (J4 ? 5 : 1), true);
      const varIndex = v.getUint16(p + (J4 ? 7 : 3), true);
      const flags = t[p + (J4 ? 15 : 13)];
      const fixedOffset = v.getUint16(p + (J4 ? 21 : 14), true);
      const len = v.getUint16(p + (J4 ? 23 : 16), true);
      columns.push({ name: '', type, num, varIndex, fixedOffset, len, fixed: (flags & 0x01) !== 0 });
    }
    for (const c of columns) {
      if (p + 2 > t.length) throw new ParseError('mdb.tdef', 'Table definition is truncated');
      if (J4) {
        const n = v.getUint16(p, true);
        c.name = ucs2(t.subarray(p + 2, p + 2 + n));
        p += 2 + n;
      } else {
        const n = t[p];
        c.name = latin1(t.subarray(p + 1, p + 1 + n));
        p += 1 + n;
      }
    }
    return { columns, rowCount };
  }

  /** Data pages owned by a table definition, in file order. */
  private dataPages(tdefPage: number): number[] {
    if (!this.dataPagesByTdef) {
      this.dataPagesByTdef = new Map();
      for (let n = 1; n < this.pages; n++) {
        const o = n * this.pageSize;
        if (this.bytes[o] !== 0x01) continue;
        const owner = this.u32(o + 4);
        (this.dataPagesByTdef.get(owner) ?? this.dataPagesByTdef.set(owner, []).get(owner)!).push(n);
      }
    }
    return this.dataPagesByTdef.get(tdefPage) ?? [];
  }

  /** All rows of a table as objects keyed by column name. */
  rows(tdefPage: number): Record<string, Cell>[] {
    const { columns } = this.tableDef(tdefPage);
    const out: Record<string, Cell>[] = [];
    const J4 = this.jet4;
    for (const pg of this.dataPages(tdefPage)) {
      const o = this.page(pg);
      const n = this.u16(o + (J4 ? 12 : 8));
      const table = o + (J4 ? 14 : 10);
      for (let i = 0; i < n; i++) {
        let start = this.u16(table + 2 * i);
        if (start & 0x8000) continue; // deleted
        let rowPage = o;
        let end = i === 0 ? this.pageSize : this.u16(table + 2 * (i - 1)) & 0x1fff;
        if (start & 0x4000) {
          // Overflow: the row holds a pointer (u8 row, u24 page) to the real row.
          const ptr = o + (start & 0x1fff);
          const r = this.u8(ptr);
          const p2 = this.u32(ptr) >>> 8;
          if (p2 >= this.pages) continue;
          rowPage = p2 * this.pageSize;
          const t2 = rowPage + (J4 ? 14 : 10);
          start = this.u16(t2 + 2 * r);
          end = r === 0 ? this.pageSize : this.u16(t2 + 2 * (r - 1)) & 0x1fff;
        }
        start &= 0x1fff;
        if (end <= start) continue;
        out.push(this.row(rowPage + start, rowPage + end, columns));
      }
    }
    return out;
  }

  private row(start: number, end: number, columns: MdbColumn[]): Record<string, Cell> {
    const J4 = this.jet4;
    const b = this.bytes;
    const nCols = J4 ? this.u16(start) : this.u8(start);
    const maskLen = (nCols + 7) >> 3;
    const mask = end - maskLen;
    if (mask < start + 2) throw new ParseError('mdb.row', `Damaged row at 0x${start.toString(16)}`, { offset: start });
    const has = (num: number) => num < nCols && (this.u8(mask + (num >> 3)) & (1 << (num & 7))) !== 0;
    // Variable-length column offsets, stored reversed before the count.
    let nVar: number;
    const varOff: number[] = [];
    if (J4) {
      nVar = this.u16(mask - 2);
      if (mask - 4 - 2 * nVar < start) throw new ParseError('mdb.row', `Damaged row at 0x${start.toString(16)}`, { offset: start });
      for (let i = 0; i <= nVar; i++) varOff.push(this.u16(mask - 4 - 2 * i));
    } else {
      // Jet 3: u8 offsets plus jump table for rows longer than 256 bytes.
      nVar = this.u8(mask - 1);
      const jumps = Math.floor((end - start - 1) / 256);
      const jt: number[] = [];
      for (let k = 0; k < jumps; k++) jt.push(this.u8(mask - 2 - k));
      let jumpIdx = 0;
      for (let i = 0; i <= nVar; i++) {
        while (jumpIdx < jt.length && i === jt[jumpIdx]) jumpIdx++;
        varOff.push(this.u8(mask - 2 - jt.length - i) + 256 * jumpIdx);
      }
    }
    const fixedBase = start + (J4 ? 2 : 1);
    const rec: Record<string, Cell> = {};
    for (const c of columns) {
      if (c.type === MDB_BOOL) {
        rec[c.name] = has(c.num);
        continue;
      }
      if (!has(c.num)) {
        rec[c.name] = null;
        continue;
      }
      if (c.fixed) {
        if (fixedBase + c.fixedOffset + (FIXED_SIZE[c.type] ?? 0) > end) {
          rec[c.name] = null;
          continue;
        }
        rec[c.name] = this.fixedValue(c.type, fixedBase + c.fixedOffset, c.len);
        continue;
      }
      if (c.varIndex >= nVar) {
        rec[c.name] = null;
        continue;
      }
      const a = start + varOff[c.varIndex],
        z = start + varOff[c.varIndex + 1];
      if (z < a || z > end) {
        rec[c.name] = null;
        continue;
      }
      rec[c.name] = this.varValue(c.type, b.subarray(a, z));
    }
    return rec;
  }

  private fixedValue(type: number, o: number, len: number): Cell {
    const v = this.view;
    switch (type) {
      case MDB_BYTE:
        return this.bytes[o];
      case MDB_INT:
        return v.getInt16(o, true);
      case MDB_LONG:
        return v.getInt32(o, true);
      case MDB_FLOAT:
        return v.getFloat32(o, true);
      case MDB_DOUBLE:
      case MDB_DATETIME:
        return v.getFloat64(o, true);
      case MDB_MONEY:
        return Number(v.getBigInt64(o, true)) / 10000;
      default:
        return len ? null : null;
    }
  }

  private varValue(type: number, d: Uint8Array): Cell {
    switch (type) {
      case MDB_TEXT:
        return this.jet4 ? jet4Text(d) : latin1(d);
      case MDB_MEMO: {
        // Inline memo: u32 length with flag 0x80000000, then 8 bytes of pointer, then text.
        if (d.length < 12) return null;
        const head = (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
        if (!(head & 0x80000000)) return null;
        return this.jet4 ? jet4Text(d.subarray(12)) : latin1(d.subarray(12));
      }
      default:
        return null;
    }
  }

  /** User tables from the MSysObjects catalog: name → TDEF page. */
  tables(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.rows(2)) {
      const type = typeof r.Type === 'number' ? r.Type : -1;
      const flags = typeof r.Flags === 'number' ? r.Flags : 0;
      const id = typeof r.Id === 'number' ? r.Id : -1;
      // Type 1 = table; system tables carry flag bits 0x80000002.
      if (type === 1 && typeof r.Name === 'string' && id > 0 && (flags & 0x80000002) === 0) out.set(r.Name, id & 0x00ffffff);
    }
    return out;
  }
}

function ucs2(d: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < d.length; i += 2) s += String.fromCharCode(d[i] | (d[i + 1] << 8));
  return s;
}
function latin1(d: Uint8Array): string {
  let s = '';
  for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
  return s;
}
/** Jet 4 text: UCS-2LE, or "compressed" (FF FE prefix; 0x00 toggles between 1-byte and 2-byte runs). */
function jet4Text(d: Uint8Array): string {
  if (d.length >= 2 && d[0] === 0xff && d[1] === 0xfe) {
    let s = '';
    let compressed = true;
    for (let i = 2; i < d.length; ) {
      if (d[i] === 0) {
        compressed = !compressed;
        i++;
        continue;
      }
      if (compressed) s += String.fromCharCode(d[i++]);
      else {
        if (i + 1 >= d.length) break;
        s += String.fromCharCode(d[i] | (d[i + 1] << 8));
        i += 2;
      }
    }
    return s;
  }
  return ucs2(d);
}
