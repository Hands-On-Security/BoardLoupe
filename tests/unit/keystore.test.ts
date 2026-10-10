/**
 * Keystore: keyfile import, format validation, and passphrase encryption at
 * rest. Uses disposable, generated test keys — never a vendor key.
 */
import { describe, expect, test } from 'vitest';
import { CAE_KEY_PARITY, FZ_KEY_PARITY } from '../../src/formats/fz';
import { decrypt, encrypt, entriesToMap, keyValid, parseKeyfile, serializeKeyfile } from '../../src/app/keystore';
import { XZZ_TEST_KEY, testKey44 } from '../../tools/fixtures/writers';

const hex44 = (parity: number[], seed: number) =>
  testKey44(parity, seed)
    .map((w) => w.toString(16).padStart(8, '0'))
    .join(' ');
const FZ = hex44(FZ_KEY_PARITY, 0x1234abcd);
const CAE = hex44(CAE_KEY_PARITY, 0x55aa00ff);

describe('keystore: validation', () => {
  test('keyValid accepts parity-valid keys and rejects junk', () => {
    expect(keyValid('fz', FZ)).toBe(true);
    expect(keyValid('cae', CAE)).toBe(true);
    expect(keyValid('xzz', XZZ_TEST_KEY)).toBe(true);
    expect(keyValid('fz', 'not a key')).toBe(false);
    expect(keyValid('xzz', 'ABCD')).toBe(false);
    // An FZ key does not pass the CAE parity table.
    expect(keyValid('cae', FZ)).toBe(false);
  });
});

describe('keystore: keyfile', () => {
  test('round-trips through serialize/parse and drops bad entries', () => {
    const text = serializeKeyfile([
      { format: 'fz', label: 'test board', key: FZ },
      { format: 'xzz', key: XZZ_TEST_KEY },
    ]);
    expect(text).toContain('"boardloupe_keystore": 1');
    const { entries, warnings } = parseKeyfile(text);
    expect(entries.map((e) => e.format)).toEqual(['fz', 'xzz']);
    expect(entriesToMap(entries)).toEqual({ fz: FZ, xzz: XZZ_TEST_KEY });
    expect(warnings).toEqual([]);
  });

  test('rejects non-keyfiles and files with no usable keys', () => {
    expect(() => parseKeyfile('[]')).toThrow(/keyfile/i);
    expect(() => parseKeyfile('{"boardloupe_keystore":1,"keys":[]}')).toThrow(/no usable keys/i);
    expect(() => parseKeyfile('{"boardloupe_keystore":1,"keys":[{"format":"fz","key":"garbage"}]}')).toThrow(/no usable keys/i);
  });

  test('warns about unknown formats and duplicates but keeps valid keys', () => {
    const doc = JSON.stringify({ boardloupe_keystore: 1, keys: [{ format: 'fz', key: FZ }, { format: 'fz', key: FZ }, { format: 'wut', key: 'x' }] });
    const { entries, warnings } = parseKeyfile(doc);
    expect(entries).toHaveLength(1);
    expect(warnings.some((w) => /duplicate/i.test(w))).toBe(true);
    expect(warnings.some((w) => /unknown/i.test(w))).toBe(true);
  });
});

describe('keystore: encryption at rest', () => {
  test('encrypt → decrypt with the right passphrase returns the keys', async () => {
    const entries = [
      { format: 'fz' as const, key: FZ },
      { format: 'xzz' as const, key: XZZ_TEST_KEY },
    ];
    const blob = await encrypt(entries, 'correct horse battery staple');
    expect(blob.v).toBe(1);
    // The serialized blob must not contain the key material.
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain(FZ.slice(0, 8));
    expect(serialized).not.toContain(XZZ_TEST_KEY);
    const back = await decrypt(blob, 'correct horse battery staple');
    expect(entriesToMap(back)).toEqual({ fz: FZ, xzz: XZZ_TEST_KEY });
  });

  test('a wrong passphrase fails with bad-passphrase', async () => {
    const blob = await encrypt([{ format: 'fz', key: FZ }], 'right');
    await expect(decrypt(blob, 'wrong')).rejects.toThrow('bad-passphrase');
  });
});
