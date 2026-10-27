/* eslint-env node */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, mocks = {}) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(id => {
    if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
    return mocks[id];
  }, module, module.exports);
  return module.exports;
}
test('guide search combines city, title and creator without changing feed order', () => {
  const { filterGuideFeed, guideCities } = load('lib/guideCatalog.ts');
  const items = [
    { kind: 'itinerary', title: 'Café afternoon', authorName: 'Asha', city: 'Delhi' },
    { kind: 'itinerary', title: 'Night out', authorName: 'Asha', city: 'Tokyo' },
    { kind: 'spot', title: 'Garden', blurb: 'Quiet walk', city: 'Delhi' },
  ];
  assert.deepEqual(filterGuideFeed(items, ' ASHA delhi ', ''), [items[0]]);
  assert.deepEqual(filterGuideFeed(items, '', 'Delhi'), [items[0], items[2]]);
  assert.deepEqual(filterGuideFeed(items, 'quiet', 'Delhi'), [items[2]]);
  assert.deepEqual(filterGuideFeed(items, 'missing', ''), []);
  assert.deepEqual(guideCities(items), ['Delhi', 'Tokyo']);
});
test('saved guides survive reload, isolate accounts and serialize concurrent writes', async () => {
  const disk = new Map();
  const storage = { getItem: async key => disk.get(key) ?? null, setItem: async (key, value) => { disk.set(key, value); } };
  const mocks = { '@react-native-async-storage/async-storage': storage };
  const saved = load('lib/savedGuides.ts', mocks);
  await Promise.all([saved.toggleSavedGuide('alice', 'first'), saved.toggleSavedGuide('alice', 'second')]);
  assert.deepEqual(await saved.readSavedGuides('alice'), ['first', 'second']);
  assert.deepEqual(await saved.readSavedGuides('bob'), []);
  assert.deepEqual(await load('lib/savedGuides.ts', mocks).readSavedGuides('alice'), ['first', 'second']);
  await saved.toggleSavedGuide('alice', 'first');
  assert.deepEqual(await saved.readSavedGuides('alice'), ['second']);
  await assert.rejects(saved.toggleSavedGuide('', 'first'));
});
test('failed storage writes reject and do not strand later saves', async () => {
  let raw = null; let fail = true;
  const saved = load('lib/savedGuides.ts', { '@react-native-async-storage/async-storage': {
    getItem: async () => raw,
    setItem: async (key, value) => { if (fail) throw new Error('disk full'); raw = value; },
  } });
  await assert.rejects(saved.toggleSavedGuide('alice', 'first'));
  assert.deepEqual(await saved.readSavedGuides('alice'), []);
  fail = false;
  await saved.toggleSavedGuide('alice', 'second');
  assert.deepEqual(await saved.readSavedGuides('alice'), ['second']);
  raw = '{corrupt';
  await assert.rejects(saved.toggleSavedGuide('alice', 'third'));
  assert.equal(raw, '{corrupt');
});
test('saved shelf resolves older guides and hides blocked authors', async () => {
  const rows = [{ id: 'old', author: 'creator', title: 'Old guide' }, { id: 'blocked', author: 'blocked-user', title: 'Hidden' }];
  let selected = [];
  const db = load('lib/db.ts', {
    './analytics': { track() {} },
    './moderation': load('lib/moderation.ts'),
    './supabase': { supabase: { from(table) {
      if (table === 'blocked_users') return { select: async () => ({ data: [{ blocked_id: 'blocked-user' }], error: null }) };
      return { select() { return this; }, eq(field, value) { assert.equal(field, 'status'); assert.equal(value, 'approved'); return this; },
        in(field, ids) { assert.equal(field, 'id'); selected = ids; return Promise.resolve({ data: rows, error: null }); } };
    } } },
  });
  const result = await db.fetchSavedGuideFeed(['old', 'blocked']);
  assert.deepEqual(selected, ['old', 'blocked']);
  assert.deepEqual(result.map(row => row.id), ['old']);
});

function databaseMock(supabase) {
  return load('lib/db.ts', { './analytics': { track() {} }, './supabase': { supabase }, './moderation': load('lib/moderation.ts') });
}
test('creator storefront filters approved author rows and paginates without displaying its sentinel', async () => {
  const calls = []; const rows = Array.from({ length: 21 }, (_, n) => ({ id: `guide-${n}`, author: 'creator', title: `Guide ${n}` }));
  const db = databaseMock({ from(table) {
    if (table === 'blocked_users') return { select: async () => ({ data: [], error: null }) };
    return { select() { return this; }, eq(...args) { calls.push(args); return this; }, order() { return this; },
      range(...args) { calls.push(args); return Promise.resolve({ data: rows, error: null }); } };
  } });
  const result = await db.fetchCreatorGuides('creator', 1);
  assert.equal(result.items.length, 20);
  assert.equal(result.nextPage, 2);
  assert.deepEqual(calls, [['status', 'approved'], ['author', 'creator'], [20, 40]]);
});
test('blocked creators never trigger a public guide query; permission errors surface', async () => {
  let calls = 0;
  const blocked = databaseMock({ from(table) {
    calls++; assert.equal(table, 'blocked_users');
    return { select: async () => ({ data: [{ blocked_id: 'creator' }], error: null }) };
  } });
  assert.deepEqual(await blocked.fetchCreatorGuides('creator'), { items: [], nextPage: null });
  assert.equal(calls, 1);
  const denied = databaseMock({ from: () => ({ select: async () => ({ data: null, error: new Error('denied') }) }) });
  await assert.rejects(denied.fetchCreatorGuides('creator'), /denied/);
});
test('cloud save sends explicit idempotent intent, never client ownership; failures reject', async () => {
  let error = null; const calls = [];
  const db = databaseMock({ rpc: async (...args) => { calls.push(args); return { error }; } });
  await db.setCloudGuideSaved('guide', true);
  await db.setCloudGuideSaved('guide', false);
  assert.deepEqual(calls, [
    ['set_saved_guide', { p_guide_id: 'guide', p_saved: true }],
    ['set_saved_guide', { p_guide_id: 'guide', p_saved: false }],
  ]);
  error = new Error('offline');
  await assert.rejects(db.setCloudGuideSaved('guide', true), /offline/);
});
test('moderation filter blocks obvious abuse without flagging place names', () => {
  const { isObjectionable, assertClean } = load('lib/moderation.ts');
  for (const bad of ['F*ck this place', 'f u c k', 'sh1t trip', 'n1gger', 'Total B!TCH']) assert.equal(isObjectionable(bad), true, bad);
  for (const ok of ['Scunthorpe day out', 'Essex coast', 'Cockburn Street', 'Dickens museum', 'Matcha in Kyoto', 'Shitamachi walk', '', null]) assert.equal(isObjectionable(ok), false, String(ok));
  assert.throws(() => assertClean('Nice title', 'fucking awful'), /language we don/);
  assert.doesNotThrow(() => assertClean('Nice title', undefined));
});
test('device saves move to the account once; unsavable ids drop, network failures stay for retry', async () => {
  const disk = new Map([['bewhim:saved-guides:v1:alice', JSON.stringify(['ok', 'gone', 'blocked', 'offline'])]]);
  const storage = {
    getItem: async k => disk.get(k) ?? null,
    setItem: async (k, v) => { disk.set(k, v); },
    removeItem: async k => { disk.delete(k); },
  };
  const saved = load('lib/savedGuides.ts', { '@react-native-async-storage/async-storage': storage });
  const uploaded = [];
  const upload = async id => {
    if (id === 'gone') throw Object.assign(new Error('fk'), { code: '23503' });
    if (id === 'blocked') throw Object.assign(new Error('rls'), { code: '42501' });
    if (id === 'offline') throw new Error('Network request failed');
    uploaded.push(id);
  };
  await saved.moveSavedGuidesToCloud('alice', upload);
  assert.deepEqual(uploaded, ['ok']);
  assert.deepEqual(await saved.readSavedGuides('alice'), ['offline']);
  await saved.moveSavedGuidesToCloud('alice', async id => { uploaded.push(id); });
  assert.deepEqual(uploaded, ['ok', 'offline']);
  assert.equal(disk.has('bewhim:saved-guides:v1:alice'), false);
  await saved.moveSavedGuidesToCloud('alice', async () => { throw new Error('should not upload'); });
  disk.set('bewhim:saved-guides:v1:bob', '{corrupt');
  await saved.moveSavedGuidesToCloud('bob', async () => { throw new Error('should not upload'); });
  assert.equal(disk.has('bewhim:saved-guides:v1:bob'), false);
});
