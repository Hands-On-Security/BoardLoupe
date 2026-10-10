/**
 * Glue between the keystore module and the app store: import a keyfile, set
 * the session keys, save them encrypted with a passphrase, unlock on reload,
 * and remove them. No plaintext key ever reaches storage here.
 */
import { retryOpen } from './actions';
import { type KeyEntry, type KeyMap, clearStoredBlob, decrypt, encrypt, entriesToMap, loadStoredBlob, mapToEntries, parseKeyfile, saveStoredBlob } from './keystore';
import { setKeys, store, toast } from './store';

/** Keys currently unlocked for this session, as entries. */
export function currentEntries(): KeyEntry[] {
  return mapToEntries(store.get().keys);
}

function apply(entries: KeyEntry[]) {
  setKeys(entriesToMap(entries));
  // If the open file failed only for want of a key, close the dialog and retry.
  const err = store.get().error;
  if (err && err.diagnostics.some((d) => /key/i.test(d.code))) {
    store.set({ dialog: null });
    retryOpen();
  }
}

/** Set the session keys directly (from the per-format fields in the dialog). */
export function setSessionKeys(map: KeyMap) {
  apply(mapToEntries(map));
}

/** Import a user keyfile (JSON) and load its keys for this session. Returns any warnings. */
export function importKeyfile(text: string): string[] {
  const { entries, warnings } = parseKeyfile(text);
  apply(entries);
  toast(`Imported ${entries.length} key${entries.length > 1 ? 's' : ''}.`);
  return warnings;
}

/** Encrypt the session keys with a passphrase and save them in this browser. */
export async function saveKeystore(passphrase: string): Promise<boolean> {
  const entries = currentEntries();
  if (!entries.length) throw new Error('There are no keys to save.');
  const blob = await encrypt(entries, passphrase);
  const ok = saveStoredBlob(blob);
  store.set({ keystore: { present: ok, unlocked: ok } });
  if (ok) toast('Keys saved (encrypted) in this browser.');
  return ok;
}

/** Decrypt the saved keystore with the passphrase and load it. Throws on a wrong passphrase. */
export async function unlockKeystore(passphrase: string): Promise<void> {
  const blob = loadStoredBlob();
  if (!blob) throw new Error('No saved keystore to unlock.');
  const entries = await decrypt(blob, passphrase);
  apply(entries);
  store.set({ keystore: { present: true, unlocked: true } });
  toast('Keystore unlocked.');
}

/** Forget the keys for this session without deleting the saved keystore. */
export function lockKeystore() {
  setKeys({});
  store.set({ keystore: { ...store.get().keystore, unlocked: false } });
}

/** Delete the saved keystore and forget the session keys. */
export function removeKeystore() {
  clearStoredBlob();
  setKeys({});
  store.set({ keystore: { present: false, unlocked: false } });
  toast('Saved keys removed from this browser.');
}
