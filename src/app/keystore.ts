/**
 * Bring-your-own-key keystore.
 *
 * BoardScope ships no keys. This module lets a user manage decryption keys
 * they are entitled to use: import a keyfile they created, see which formats
 * have a key (never the material), save it to this browser encrypted with a
 * passphrase, unlock it on a later visit, replace it, and remove it.
 *
 * At rest the keys are AES-GCM encrypted with a key derived from the
 * passphrase by PBKDF2-HMAC-SHA-256. The passphrase is never stored; without
 * it the stored blob is undecryptable. Plaintext key material never touches
 * localStorage, logs, reports, screenshots or exports — only the user's own
 * keyfile download and the in-memory parse options carry it.
 */
import { CAE_KEY_PARITY, FZ_KEY_PARITY, keyParityOk, parseKey44 } from '../formats/fz';
import { parseXzzKey, xzzKeyParityOk } from '../formats/xzz';

export type KeyFormat = 'fz' | 'cae' | 'xzz';

/** Formats that use a user-supplied key, in display order. */
export const KEY_FORMATS: { id: KeyFormat; label: string; hint: string }[] = [
  { id: 'fz', label: 'FZ (ASUS)', hint: '44 hexadecimal words' },
  { id: 'cae', label: 'CAE', hint: '44 hexadecimal words' },
  { id: 'xzz', label: 'XZZ PCB', hint: '16 hexadecimal digits' },
];

export interface KeyEntry {
  format: KeyFormat;
  /** Optional free-text label the user gave the key (board, vendor…). Never the key. */
  label?: string;
  key: string;
}

export type KeyMap = Partial<Record<KeyFormat, string>>;

/** True when the key material is well-formed and passes the format's parity check. */
export function keyValid(format: KeyFormat, key: string): boolean {
  if (!key) return false;
  if (format === 'xzz') {
    const k = parseXzzKey(key);
    return !!k && xzzKeyParityOk(k[0], k[1]);
  }
  const k = parseKey44(key);
  return !!k && keyParityOk(k, format === 'fz' ? FZ_KEY_PARITY : CAE_KEY_PARITY);
}

export function entriesToMap(entries: KeyEntry[]): KeyMap {
  const m: KeyMap = {};
  for (const e of entries) if (e.key) m[e.format] = e.key;
  return m;
}

export function mapToEntries(map: KeyMap): KeyEntry[] {
  return KEY_FORMATS.filter((f) => map[f.id]).map((f) => ({ format: f.id, key: map[f.id]! }));
}

// ── Keyfile (plaintext JSON the user creates and owns) ──────────────────────

interface Keyfile {
  boardscope_keystore: 1;
  created: string;
  keys: KeyEntry[];
}

export function serializeKeyfile(entries: KeyEntry[]): string {
  const file: Keyfile = {
    boardscope_keystore: 1,
    created: new Date().toISOString(),
    keys: entries.filter((e) => e.key).map((e) => ({ format: e.format, ...(e.label ? { label: e.label } : {}), key: e.key.trim() })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Parses an imported keyfile, keeping only known, well-shaped entries. Throws on a non-keyfile. */
export function parseKeyfile(text: string): { entries: KeyEntry[]; warnings: string[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not a keyfile: the file is not valid JSON.');
  }
  const o = doc as Partial<Keyfile>;
  if (!o || o.boardscope_keystore !== 1 || !Array.isArray(o.keys)) throw new Error('Not a BoardScope keyfile (missing "boardscope_keystore": 1).');
  const known = new Set(KEY_FORMATS.map((f) => f.id));
  const entries: KeyEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of o.keys) {
    const fmt = String((raw as KeyEntry)?.format ?? '').toLowerCase() as KeyFormat;
    const key = String((raw as KeyEntry)?.key ?? '').trim();
    const label = (raw as KeyEntry)?.label ? String((raw as KeyEntry).label).slice(0, 80) : undefined;
    if (!known.has(fmt)) {
      warnings.push(`Ignored a key for an unknown format "${fmt}".`);
      continue;
    }
    if (seen.has(fmt)) {
      warnings.push(`Ignored a duplicate ${fmt.toUpperCase()} key.`);
      continue;
    }
    if (!keyValid(fmt, key)) {
      warnings.push(`Ignored a ${fmt.toUpperCase()} key that fails its format check.`);
      continue;
    }
    seen.add(fmt);
    entries.push({ format: fmt, label, key });
  }
  if (!entries.length) throw new Error('The keyfile has no usable keys.');
  return { entries, warnings };
}

// ── Encryption at rest (passphrase, never persisted) ────────────────────────

export interface EncBlob {
  v: 1;
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  iters: number;
  salt: string;
  iv: string;
  ct: string;
}

const ITERATIONS = 310_000;
const subtle = () => globalThis.crypto?.subtle;

export function cryptoAvailable(): boolean {
  return !!subtle();
}

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iters: number): Promise<CryptoKey> {
  const s = subtle();
  if (!s) throw new Error('This browser has no Web Crypto; a passphrase-protected keystore is not available here.');
  const base = await s.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(entries: KeyEntry[], passphrase: string): Promise<EncBlob> {
  const s = subtle();
  if (!s) throw new Error('This browser has no Web Crypto; a passphrase-protected keystore is not available here.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(entries.map((e) => ({ format: e.format, label: e.label, key: e.key }))));
  const ct = await s.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource);
  return { v: 1, kdf: 'PBKDF2', hash: 'SHA-256', iters: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Decrypts the stored blob. Throws Error('bad-passphrase') when the passphrase is wrong. */
export async function decrypt(blob: EncBlob, passphrase: string): Promise<KeyEntry[]> {
  const s = subtle();
  if (!s) throw new Error('This browser has no Web Crypto; a passphrase-protected keystore is not available here.');
  const key = await deriveKey(passphrase, unb64(blob.salt), blob.iters || ITERATIONS);
  let plain: ArrayBuffer;
  try {
    plain = await s.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ct) as BufferSource);
  } catch {
    throw new Error('bad-passphrase');
  }
  const arr = JSON.parse(new TextDecoder().decode(plain)) as KeyEntry[];
  return arr.filter((e) => e && keyValid(e.format, e.key));
}

// ── Persistence (only the encrypted blob is ever stored) ────────────────────

const STORAGE_KEY = 'boardscope.keystore.v1';

export function hasStoredKeystore(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

export function loadStoredBlob(): EncBlob | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as EncBlob;
    return b && b.v === 1 && b.ct ? b : null;
  } catch {
    return null;
  }
}

export function saveStoredBlob(blob: EncBlob): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredBlob() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}
