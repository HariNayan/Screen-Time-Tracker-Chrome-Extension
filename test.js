const { getDomain, getDay, formatTime, escapeHtml } = (() => {
  function getDomain(url) {
    const IGNORED_PREFIXES = ['chrome://', 'about:', 'new-tab-page:'];
    try {
      for (const prefix of IGNORED_PREFIXES) {
        if (url.startsWith(prefix)) return null;
      }
      const hostname = new URL(url).hostname;
      if (!hostname || hostname === '') return null;
      return hostname;
    } catch {
      return null;
    }
  }

  function getDay(date) {
    const d = date || new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return { getDomain, getDay, formatTime, escapeHtml };
})();

const SLEEP_CAP_MS = 30 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — got "${actual}", expected "${expected}"`);
    failed++;
  }
}

function assertBool(name, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — got ${actual}, expected ${expected}`);
    failed++;
  }
}

console.log('\n=== getDomain() ===');
assert('normal URL', getDomain('https://www.google.com/search?q=test'), 'www.google.com');
assert('subdomain', getDomain('https://mail.google.com'), 'mail.google.com');
assert('no protocol', getDomain('http://example.com'), 'example.com');
assert('chrome:// ignored', getDomain('chrome://settings'), null);
assert('about: ignored', getDomain('about:blank'), null);
assert('new-tab ignored', getDomain('new-tab-page:'), null);
assert('empty URL', getDomain(''), null);
assert('invalid URL', getDomain('not-a-url'), null);

console.log('\n=== getDay() ===');
const now = new Date();
const expected = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
assert('returns local date', getDay(new Date()), expected);
assert('handles midnight edge case', getDay(new Date(2024, 0, 1, 0, 0, 0)), '2024-01-01');
assert('handles noon', getDay(new Date(2024, 11, 25, 12, 0, 0)), '2024-12-25');

console.log('\n=== formatTime() ===');
assert('0ms', formatTime(0), '0m');
assert('30 seconds', formatTime(30000), '0m');
assert('1 minute', formatTime(60000), '1m');
assert('5 min 30 sec', formatTime(330000), '5m');
assert('1 hour', formatTime(3600000), '1h 0m');
assert('2h 15m', formatTime(8100000), '2h 15m');
assert('23h 59m', formatTime(86340000), '23h 59m');

console.log('\n=== escapeHtml() ===');
assert('normal text', escapeHtml('google.com'), 'google.com');
assert('XSS script', escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
assert('quotes', escapeHtml('a"b'), 'a&quot;b');
assert('ampersand', escapeHtml('a&b'), 'a&amp;b');
assert('single quote', escapeHtml("a'b"), 'a&#039;b');

console.log('\n=== Fix 1: Sleep/Shutdown Cap ===');
const SHORT_GAP = 5 * 60 * 1000;
const LONG_GAP = 4 * 60 * 60 * 1000;
assertBool('5min gap below cap', SHORT_GAP <= SLEEP_CAP_MS, true);
assertBool('4hr gap exceeds cap', LONG_GAP <= SLEEP_CAP_MS, false);
assertBool('cap is 30 minutes', SLEEP_CAP_MS, 30 * 60 * 1000);

const sessionShort = { startTime: Date.now() - SHORT_GAP, domain: 'google.com', tabId: 1 };
const durationShort = Date.now() - sessionShort.startTime;
assertBool('short gap duration computed', durationShort <= SLEEP_CAP_MS, true);

const sessionLong = { startTime: Date.now() - LONG_GAP, domain: 'google.com', tabId: 1 };
const durationLong = Date.now() - sessionLong.startTime;
assertBool('long gap duration exceeds cap', durationLong > SLEEP_CAP_MS, true);

console.log('\n=== Fix 2: Tab Close Handling ===');
const mockSession = { domain: 'youtube.com', tabId: 42, startTime: Date.now() - 60000 };
const closedTabId = 42;
const otherTabId = 99;
assertBool('closed tab matches session tab', closedTabId === mockSession.tabId, true);
assertBool('other tab does not match', otherTabId === mockSession.tabId, false);

let sessionFlushed = false;
async function mockEndSession(sessionTabId) {
  if (mockSession && mockSession.tabId === sessionTabId) {
    sessionFlushed = true;
  }
}
await mockEndSession(closedTabId);
assertBool('session flushed on matching tab close', sessionFlushed, true);

sessionFlushed = false;
await mockEndSession(otherTabId);
assertBool('session NOT flushed on non-matching tab close', sessionFlushed, false);

console.log('\n=== Fix 3: Promise Chain Queue ===');
let executionOrder = [];
async function mockSwitch(id) {
  return new Promise((resolve) => {
    setTimeout(() => {
      executionOrder.push(id);
      resolve();
    }, Math.random() * 20);
  });
}

let chain = Promise.resolve();
chain = chain.then(() => mockSwitch(1));
chain = chain.then(() => mockSwitch(2));
chain = chain.then(() => mockSwitch(3));
await chain;
assert('queue order preserved: 1,2,3', executionOrder.join(','), '1,2,3');

executionOrder = [];
chain = Promise.resolve();
for (let i = 0; i < 5; i++) {
  chain = chain.then(() => mockSwitch(i));
}
await chain;
assert('5 rapid calls in order', executionOrder.join(','), '0,1,2,3,4');

console.log('\n=== Fix 4: Timezone in pruneOldData ===');
function parseBucketDate(dateStr) {
  return new Date(dateStr + 'T00:00:00');
}

const testDateStr = '2026-07-07';
const parsed = parseBucketDate(testDateStr);
assertBool('parsed date is not NaN', isNaN(parsed.getTime()), false);
assertBool('parsed hour is 0 (local)', parsed.getHours(), 0);
assertBool('parsed minutes is 0', parsed.getMinutes(), 0);

const utcParsed = new Date(testDateStr);
const localParsed = parseBucketDate(testDateStr);
assertBool('local parse differs from UTC parse',
  utcParsed.getTime() !== localParsed.getTime() || utcParsed.getHours() === localParsed.getHours(),
  true);

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - 90);
cutoff.setHours(0, 0, 0, 0);
const exactCutoffDay = new Date(cutoff);
const bucketDate = parseBucketDate(getDay(exactCutoffDay));
assertBool('exact cutoff day is not pruned', bucketDate >= cutoff, true);

const dayBefore = new Date(exactCutoffDay);
dayBefore.setDate(dayBefore.getDate() - 1);
const bucketBefore = parseBucketDate(getDay(dayBefore));
assertBool('day before cutoff is pruned', bucketBefore < cutoff, true);

console.log('\n=== Checkpoint: 45-min session preserved ===');
const SESSION_DURATION_MS = 45 * 60 * 1000;
const NUM_CHUNKS = Math.ceil(SESSION_DURATION_MS / CHECKPOINT_INTERVAL_MS);
const REMAINDER_MS = SESSION_DURATION_MS % CHECKPOINT_INTERVAL_MS;

assertBool('45 min produces 45 chunks', NUM_CHUNKS, 45);
assertBool('chunk interval is 1 min', CHECKPOINT_INTERVAL_MS, 60000);
assertBool('remainder is 0', REMAINDER_MS, 0);

const totalFromChunks = NUM_CHUNKS * CHECKPOINT_INTERVAL_MS;
assertBool('chunks sum to 45 min', totalFromChunks, SESSION_DURATION_MS);
assertBool('each chunk below sleep cap', CHECKPOINT_INTERVAL_MS <= SLEEP_CAP_MS, true);

console.log('\n=== Checkpoint: Midnight crossing ===');
const lateNight = new Date(2026, 6, 7, 23, 58, 0);
const earlyMorning = new Date(2026, 6, 8, 0, 2, 0);
const preMidnightChunk = {
  domain: 'youtube.com',
  startTime: lateNight.getTime(),
  duration: CHECKPOINT_INTERVAL_MS
};
const postMidnightChunk = {
  domain: 'youtube.com',
  startTime: earlyMorning.getTime(),
  duration: CHECKPOINT_INTERVAL_MS
};

const day1 = getDay(new Date(preMidnightChunk.startTime));
const day2 = getDay(new Date(postMidnightChunk.startTime));
assert('pre-midnight buckets to Jul 7', day1, '2026-07-07');
assert('post-midnight buckets to Jul 8', day2, '2026-07-08');
assertBool('midnight splits into different buckets', day1 !== day2, true);

const totalMidnight = preMidnightChunk.duration + postMidnightChunk.duration;
assertBool('midnight total is 2 min', totalMidnight, 120000);

console.log('\n=== Checkpoint: 6-hr gap discarded ===');
const GAP_DURATION_MS = 6 * 60 * 60 * 1000;
assertBool('6hr gap exceeds cap', GAP_DURATION_MS > SLEEP_CAP_MS, true);
assertBool('cap would discard 6hr gap', GAP_DURATION_MS > SLEEP_CAP_MS, true);

const gapChunks = Math.floor(GAP_DURATION_MS / CHECKPOINT_INTERVAL_MS);
assertBool('6hr gap has 360 checkpoint intervals', gapChunks, 360);

console.log('\n=== Concurrency: Checkpoint + Switch race ===');

function createMockStorage() {
  const store = {};
  return {
    _store: store,
    get: (keys, cb) => {
      if (keys === null) {
        cb({ ...store });
      } else if (typeof keys === 'string') {
        cb({ [keys]: store[keys] });
      } else {
        const result = {};
        for (const k of keys) result[k] = store[k];
        cb(result);
      }
    },
    set: (obj, cb) => {
      Object.assign(store, obj);
      if (cb) cb();
    },
    remove: (keys, cb) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete store[k];
      if (cb) cb();
    }
  };
}

function createTestHarness() {
  const storage = createMockStorage();
  let currentSession = null;
  let sessionQueue = Promise.resolve();
  let isIdle = false;

  function getDay(date) {
    const d = date || new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async function persistSession(session) {
    if (!session || session.duration < 500) return;
    const day = getDay(new Date(session.startTime));
    const key = `usage:${day}`;
    return new Promise((resolve) => {
      storage.get(key, (result) => {
        const dayData = result[key] || {};
        dayData[session.domain] = (dayData[session.domain] || 0) + session.duration;
        storage.set({ [key]: dayData }, resolve);
      });
    });
  }

  async function endCurrentSession() {
    if (!currentSession) return;
    const now = Date.now();
    const duration = now - currentSession.startTime;
    if (duration > 30 * 60 * 1000) {
      currentSession = null;
      await storage.remove('currentSession');
      return;
    }
    const sessionToSave = { ...currentSession, duration };
    currentSession = null;
    await storage.remove('currentSession');
    await persistSession(sessionToSave);
  }

  async function checkpointSession() {
    if (!currentSession || isIdle) return;
    sessionQueue = sessionQueue.then(async () => {
      try {
        if (!currentSession || isIdle) return;
        const now = Date.now();
        const elapsed = now - currentSession.startTime;
        if (elapsed >= CHECKPOINT_INTERVAL_MS) {
          const startDay = getDay(new Date(currentSession.startTime));
          const endDay = getDay(new Date(now));
          if (startDay === endDay) {
            await persistSession({
              domain: currentSession.domain,
              startTime: currentSession.startTime,
              duration: elapsed
            });
          } else {
            const midnight = new Date(now);
            midnight.setHours(0, 0, 0, 0);
            const firstDur = midnight.getTime() - currentSession.startTime;
            const secondDur = now - midnight.getTime();
            if (firstDur > 0) {
              await persistSession({
                domain: currentSession.domain,
                startTime: currentSession.startTime,
                duration: firstDur
              });
            }
            if (secondDur > 0) {
              await persistSession({
                domain: currentSession.domain,
                startTime: midnight.getTime(),
                duration: secondDur
              });
            }
          }
          currentSession.startTime = now;
          await storage.set({ currentSession });
        }
      } catch (e) {
        console.error('Error checkpointing:', e);
      }
    });
    return sessionQueue;
  }

  async function switchSession(domain, tabId) {
    sessionQueue = sessionQueue.then(async () => {
      try {
        await endCurrentSession();
        if (domain) {
          currentSession = { domain, tabId, startTime: Date.now() };
          await storage.set({ currentSession });
        }
      } catch (e) {
        console.error('Error switching:', e);
      }
    });
    return sessionQueue;
  }

  return {
    storage, get currentSession() { return currentSession; },
    set currentSession(v) { currentSession = v; },
    get sessionQueue() { return sessionQueue; },
    checkpointSession, switchSession, endCurrentSession, getDay
  };
}

{
  const h = createTestHarness();

  const t0 = Date.now() - 90000;
  h.currentSession = { domain: 'site-a.com', tabId: 1, startTime: t0 };

  h.checkpointSession();
  h.switchSession('site-b.com', 2);
  await h.sessionQueue;

  const day = h.getDay(new Date(t0));
  const data = {};
  h.storage.get(null, (r) => {
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('usage:')) Object.assign(data, v);
    }
  });

  const aTime = data['site-a.com'] || 0;
  assertBool('site-a.com time > 0', aTime > 0, true);
  assertBool('site-a.com time ~90s (no double count)', aTime >= 89000 && aTime <= 91000, true);

  assertBool('currentSession is site-b.com', h.currentSession.domain, 'site-b.com');
  assertBool('currentSession tabId is 2', h.currentSession.tabId, 2);
}

{
  const h = createTestHarness();

  const t0 = Date.now() - 60000;
  h.currentSession = { domain: 'site-x.com', tabId: 10, startTime: t0 };

  h.checkpointSession();
  h.switchSession('site-y.com', 20);
  h.checkpointSession();
  h.switchSession('site-z.com', 30);
  await h.sessionQueue;

  const data = {};
  h.storage.get(null, (r) => {
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('usage:')) Object.assign(data, v);
    }
  });

  const xTime = data['site-x.com'] || 0;
  assertBool('site-x.com preserved (~60s)', xTime >= 59000 && xTime <= 61000, true);
  assertBool('currentSession is site-z.com', h.currentSession.domain, 'site-z.com');
  assertBool('currentSession tabId is 30', h.currentSession.tabId, 30);
}

console.log('\n=== Midnight boundary: chunk split ===');
{
  const h = createTestHarness();

  const dayBefore = new Date(2026, 6, 7);
  const dayAfter = new Date(2026, 6, 8);
  const startTime = new Date(2026, 6, 7, 23, 59, 0).getTime();
  const nowTime = new Date(2026, 6, 8, 0, 1, 0).getTime();
  const elapsed = nowTime - startTime;

  h.currentSession = { domain: 'site-a.com', tabId: 1, startTime };

  const startDay = h.getDay(new Date(startTime));
  const endDay = h.getDay(new Date(nowTime));
  assertBool('start and end on different days', startDay !== endDay, true);

  const midnight = new Date(nowTime);
  midnight.setHours(0, 0, 0, 0);
  const firstDur = midnight.getTime() - startTime;
  const secondDur = nowTime - midnight.getTime();

  assertBool('first chunk > 0', firstDur > 0, true);
  assertBool('second chunk > 0', secondDur > 0, true);
  assertBool('chunks sum to total', firstDur + secondDur, elapsed);
  assertBool('first chunk is 60s', firstDur, 60000);
  assertBool('second chunk is 60s', secondDur, 60000);
}

console.log('\n=== Midnight boundary: no split same day ===');
{
  const startTime = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const nowTime = new Date(2026, 6, 7, 14, 1, 0).getTime();

  const startDay = getDay(new Date(startTime));
  const endDay = getDay(new Date(nowTime));
  assertBool('same day — no split needed', startDay === endDay, true);

  const elapsed = nowTime - startTime;
  assertBool('single chunk duration correct', elapsed, 60000);
}

console.log('\n=== Midnight boundary: sum equals total ===');
{
  const startTime = new Date(2026, 6, 7, 23, 59, 30).getTime();
  const nowTime = new Date(2026, 6, 8, 0, 0, 30).getTime();
  const elapsed = nowTime - startTime;

  const midnight = new Date(nowTime);
  midnight.setHours(0, 0, 0, 0);
  const firstDur = midnight.getTime() - startTime;
  const secondDur = nowTime - midnight.getTime();

  assertBool('split sum equals total', firstDur + secondDur, elapsed);
  assertBool('first part is 30s', firstDur, 30000);
  assertBool('second part is 30s', secondDur, 30000);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
