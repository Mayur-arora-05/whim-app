/* eslint-env node */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

// Run the real TS modules against explicit service doubles. Unknown imports
// fail closed: these tests cannot accidentally reach Supabase or device APIs.
function load(file, mocks = {}, dev = false) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__DEV__', outputText)(id => {
    if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
    return mocks[id];
  }, module, module.exports, dev);
  return module.exports;
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise(r => setImmediate(r));

function build(platform, constants, dev = false) {
  return load('lib/buildInfo.ts', { 'expo-constants': constants, 'react-native': { Platform: { OS: platform } } }, dev);
}
test('build tags use the installed platform and label fallback/unknown values', () => {
  const constants = { platform: { ios: { buildNumber: '12' }, android: { versionCode: 9 } }, expoConfig: { version: '1.0.0', ios: { buildNumber: '13' } } };
  const ios = build('ios', constants);
  assert.equal(ios.APP_VERSION, '1.0.0 (12)');
  assert.equal(ios.BUILD_INFO.build_source, 'native');
  assert.equal(build('android', constants).BUILD_INFO.build_number, '9');
  assert.equal(build('android', { expoConfig: constants.expoConfig }).BUILD_INFO.build_number, null);
  assert.equal(build('ios', { expoConfig: constants.expoConfig }, true).BUILD_INFO.environment, 'development');
  assert.equal(build('ios', { expoConfig: constants.expoConfig }).BUILD_INFO.build_source, 'manifest');
  assert.equal(build('web', constants).BUILD_INFO.build_number, null);
});
test('events and errors share authoritative build tags; telemetry failures never escape', async () => {
  const rows = [];
  let failure = '';
  const supabase = { from(table) {
    if (failure === 'sync') throw new Error('offline');
    return { insert(row) {
      if (failure === 'async') return Promise.reject(new Error('offline'));
      rows.push({ table, row }); return Promise.resolve({ error: null });
    } };
  } };
  const { track, logError } = load('lib/analytics.ts', { './supabase': { supabase }, './buildInfo': { BUILD_INFO: { environment: 'development', build_number: '12' } } });
  track('nearby_loaded', { duration_ms: 200, environment: 'release' });
  logError(new Error('broken'), true, { source: 'test' });
  assert.equal(rows[0].row.props.environment, 'development');
  assert.equal(rows[1].row.context.build_number, '12');
  assert.equal(rows[1].row.fatal, true);
  for (failure of ['sync', 'async']) {
    assert.doesNotThrow(() => track('test'));
    assert.doesNotThrow(() => logError(new Error('test')));
    await flush();
  }
});
test('save/create/join events only follow successful persistence', async () => {
  const events = [];
  let error = null;
  const supabase = {
    from: () => ({ upsert: async () => ({ error }) }),
    rpc: async () => ({ error, data: { id: 'room', city: 'Delhi', vibe: 'classics' } }),
  };
  const db = load('lib/db.ts', { './supabase': { supabase }, './analytics': { track: (...args) => events.push(args) }, './moderation': load('lib/moderation.ts') });
  await db.saveSpot({ id: 'spot' }, [], 'Delhi', 'classics', 'super');
  await db.createRoom('Delhi', 'classics');
  await db.joinRoom('SECRET');
  assert.deepEqual(events.map(e => e[0]), ['spot_saved', 'room_created', 'room_joined']);
  assert.equal(events[0][1].via, 'super');
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  error = new Error('write failed');
  await assert.rejects(db.saveSpot({ id: 'spot' }, [], 'Delhi', 'classics'));
  await assert.rejects(db.createRoom('Delhi', 'classics'));
  await assert.rejects(db.joinRoom('SECRET'));
  assert.equal(events.length, 3);
});

function solo(overrides = {}) {
  const events = [], saves = [];
  const db = {
    fetchDeck: async () => [{ id: 'a' }],
    saveSpot: async (...args) => { saves.push(args); },
    removeSavedSpot: async () => {}, clearSavedSpots: async () => {},
    ...overrides,
  };
  const { useWhimStore: store } = load('store/useWhimStore.ts', {
    zustand: require('zustand'),
    'zustand/middleware': require('zustand/middleware'),
    '@react-native-async-storage/async-storage': { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    '@/lib/db': db, '@/data/mockDeck': { getDeck: () => [] },
    '@/lib/analytics': { track: (...args) => events.push(args) },
    '@/lib/push': {}, '@/lib/toast': { toast: () => {} }, '@/lib/verifyLocation': {},
  });
  return { store, events, saves };
}
test('empty deck is loaded but not finished; context changes invalidate its load state', async () => {
  const { store, events } = solo({ fetchDeck: async () => [] });
  await store.getState().setContext('Delhi', 'classics');
  assert.equal(store.getState().deckLoaded, true);
  store.getState().swipeLeft();
  assert.equal(store.getState().deckIndex, 0);
  assert.ok(!events.some(e => e[0] === 'deck_finished'));
  store.getState().setVibe('nature');
  assert.equal(store.getState().deckLoaded, false);
});
for (const action of ['swipeLeft', 'swipeRight', 'superSave']) {
  test(`${action}: finish once, including after undo; super-save delegates its one save event`, async () => {
    const { store, events, saves } = solo();
    await store.getState().setContext('Delhi', 'classics');
    store.getState()[action]();
    store.getState().undoLast();
    store.getState()[action]();
    store.getState()[action]();
    assert.equal(events.filter(e => e[0] === 'deck_finished').length, 1);
    assert.equal(events.filter(e => e[0] === 'spot_saved').length, 0);
    if (action === 'superSave') assert.equal(saves[0][4], 'super');
  });
}
test('a stale deck cannot replace the newer city or survive account reset', async () => {
  const old = deferred();
  const { store } = solo({ fetchDeck: city => city === 'Old' ? old.promise : Promise.resolve([{ id: 'new' }]) });
  const pending = store.getState().setContext('Old', 'classics');
  await store.getState().setContext('New', 'classics');
  old.resolve([{ id: 'old' }]); await pending;
  assert.equal(store.getState().deck[0].id, 'new');
  const late = deferred();
  const other = solo({ fetchDeck: () => late.promise }).store;
  const loadPromise = other.getState().setContext('Old', 'classics');
  other.getState().reset(); late.resolve([{ id: 'old' }]); await loadPromise;
  assert.equal(other.getState().deckLoaded, false);
  assert.equal(other.getState().deck.length, 0);
});

function roomHarness() {
  const events = [];
  let subscriptions = 0;
  const db = {
    fetchRoom: async id => ({ id, city: 'Delhi', vibe: 'classics' }),
    fetchRoomMembers: async () => [], fetchDeck: async () => [],
    fetchMyRoomVotes: async () => [], fetchBlockedUserIds: async () => [],
    fetchRoomMatches: async () => [],
    fetchSpotsByIds: async ids => ids.map(id => ({ id, title: id })),
    castRoomVote: async () => {},
  };
  const channel = { on: () => channel, subscribe: () => { subscriptions++; return channel; } };
  const { useRoomStore: store } = load('store/useRoomStore.ts', {
    react: { useEffect: () => {} }, zustand: require('zustand'),
    '@/lib/supabase': { supabase: { channel: () => channel, removeChannel: () => {} } },
    '@/lib/db': db, '@/lib/toast': { toast: () => {} }, '@/lib/haptics': { hapticSuccess: () => {} },
    '@/lib/analytics': { track: (...args) => events.push(args) },
  });
  return { store, db, events, subscriptions: () => subscriptions };
}
test('leaving during enter does not restore state or subscribe', async () => {
  const { store, db, subscriptions } = roomHarness();
  const pending = deferred(); db.fetchDeck = () => pending.promise;
  const entering = store.getState().enter('a');
  await flush(); store.getState().leave(); pending.resolve([]); await entering;
  assert.equal(store.getState().room, null);
  assert.equal(subscriptions(), 0);
});
test('late room matches and members cannot restore state after leaving', async () => {
  const { store, db, events } = roomHarness();
  await store.getState().enter('a');
  const matches = deferred(), members = deferred();
  db.fetchRoomMatches = () => matches.promise; db.fetchRoomMembers = () => members.promise;
  const refreshing = store.getState().refreshMatches();
  const refreshingMembers = store.getState().refreshMembers();
  store.getState().leave();
  matches.resolve([{ spotId: 'old', likes: 2 }]); members.resolve([{ userId: 'old' }]);
  await Promise.all([refreshing, refreshingMembers]);
  assert.deepEqual(store.getState().matches, []);
  assert.deepEqual(store.getState().members, []);
  assert.equal(events.length, 0);
});
test('out-of-order realtime refreshes keep newest matches and count a match once', async () => {
  const { store, db, events } = roomHarness();
  await store.getState().enter('a');
  const older = deferred(), newer = deferred();
  let calls = 0; db.fetchRoomMatches = () => calls++ ? newer.promise : older.promise;
  const p1 = store.getState().refreshMatches(), p2 = store.getState().refreshMatches();
  newer.resolve([{ spotId: 'new', likes: 2 }]); await p2;
  older.resolve([{ spotId: 'old', likes: 2 }]); await p1;
  assert.equal(store.getState().matches[0].spot.id, 'new');
  db.fetchRoomMatches = async () => [{ spotId: 'new', likes: 2 }];
  await store.getState().refreshMatches();
  assert.equal(events.filter(e => e[0] === 'room_match').length, 1);
});
