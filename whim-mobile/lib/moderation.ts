// First-line filter for text other people will see (guide titles/notes, room
// names, display names, handles) — App Store 1.2 asks for "a method for
// filtering objectionable material". It's a blocklist, so it only catches the
// obvious; reports + blocking + manual review (scripts/review-reports.mjs)
// handle the rest.

// Whole words only, so place names like "Scunthorpe" or "Essex" stay fine.
const WORDS = new Set([
  'fuck', 'fucker', 'fucking', 'fucked', 'motherfucker', 'shit', 'bullshit', 'cunt', 'cunts', 'bitch', 'bitches',
  'whore', 'whores', 'slut', 'sluts', 'dick', 'dicks', 'cock', 'cocks', 'pussy', 'porn', 'porno', 'nude', 'nudes',
  'rape', 'raped', 'rapist', 'nazi', 'nazis', 'hitler', 'kkk', 'retard', 'retarded', 'tranny', 'chink', 'chinks',
  'spic', 'spics', 'kike', 'kikes', 'paki', 'pakis', 'wetback', 'gook', 'gooks', 'coon', 'coons', 'dyke', 'faggot',
  'faggots', 'fag', 'fags', 'nigger', 'niggers', 'nigga', 'niggas', 'randi', 'chutiya', 'madarchod', 'bhenchod',
  'behenchod', 'bhosdike', 'gandu', 'lund',
]);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** True when `text` contains a blocked word (case, accents and simple leetspeak ignored). */
export function isObjectionable(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[013457@$!]/g, (c) => LEET[c] ?? c);
  // "f.u.c.k" / "f u c k": collapse runs of single letters into one word
  const collapsed = normalized.replace(/\b(?:[a-z][\s._-]){2,}[a-z]\b/g, (m) => m.replace(/[\s._-]/g, ''));
  return collapsed.split(/[^a-z*]+/).some((w) => {
    if (!w.includes('*')) return WORDS.has(w);
    // "f*ck": * stands for one hidden letter
    if (!/[a-z]/.test(w)) return false;
    const masked = new RegExp(`^${w.replace(/\*/g, '[a-z]')}$`);
    for (const bad of WORDS) if (bad.length === w.length && masked.test(bad)) return true;
    return false;
  });
}

/** Throws a friendly error if any field is objectionable. */
export function assertClean(...fields: (string | null | undefined)[]): void {
  if (fields.some(isObjectionable)) {
    throw new Error('That contains language we don’t allow. Please edit it and try again.');
  }
}
