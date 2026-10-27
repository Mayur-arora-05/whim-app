import AsyncStorage from '@react-native-async-storage/async-storage';

const key = (userId: string) => `bewhim:saved-guides:v1:${userId}`;
const pending = new Map<string, Promise<unknown>>();

export async function readSavedGuides(userId: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(key(userId));
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('Couldn’t read saved guides.');
  return [...new Set(value as string[])];
}

// Serialize writes per account so saving two guides cannot lose one of them.
export async function toggleSavedGuide(userId: string, guideId: string): Promise<string[]> {
  if (!userId || !guideId) throw new Error('Sign in to save a guide.');
  const previous = pending.get(userId) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const ids = await readSavedGuides(userId);
    const next = ids.includes(guideId) ? ids.filter(id => id !== guideId) : [...ids, guideId];
    await AsyncStorage.setItem(key(userId), JSON.stringify(next));
    return next;
  });
  pending.set(userId, write);
  try { return await write; }
  finally { if (pending.get(userId) === write) pending.delete(userId); }
}

// Postgres codes that mean "this guide can never be saved": RLS refused it
// (unapproved or blocked author), it no longer exists, or the id is malformed.
const PERMANENT = new Set(['42501', '23503', '22P02']);

/** One-time move of device-only saves (builds before cloud sync) into the
 * account. Each upload is idempotent; ids that can never be saved are dropped,
 * ids that hit a network error stay on the device for the next attempt. */
export async function moveSavedGuidesToCloud(userId: string, upload: (guideId: string) => Promise<void>): Promise<void> {
  const previous = pending.get(userId) ?? Promise.resolve();
  const move = previous.catch(() => {}).then(async () => {
    let ids: string[];
    try { ids = await readSavedGuides(userId); } catch { ids = []; } // unreadable → nothing to move
    if (!ids.length) { await AsyncStorage.removeItem(key(userId)); return; }
    const left: string[] = [];
    for (const id of ids) {
      try { await upload(id); } catch (e: any) { if (!PERMANENT.has(e?.code)) left.push(id); }
    }
    if (left.length) await AsyncStorage.setItem(key(userId), JSON.stringify(left));
    else await AsyncStorage.removeItem(key(userId));
  });
  pending.set(userId, move);
  try { await move; }
  finally { if (pending.get(userId) === move) pending.delete(userId); }
}
