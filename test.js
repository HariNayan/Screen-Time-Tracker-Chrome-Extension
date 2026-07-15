import {
  getDomain,
  getDay,
  formatTime,
  escapeHtml,
  getPruneKeys,
  getBaseDomain,
  groupByBaseDomain,
  isExcluded,
  domainHue,
  toCsv,
  computeVisits,
  longestSession,
  pickInsight
} from './lib.js';
import {
  createSessionManager,
  appendToLog,
  DEBOUNCE_MS,
  SLEEP_CAP_MS,
  CHECKPOINT_INTERVAL_MS,
  SESSION_LOG_CAP,
  COALESCE_GAP_MS
} from './session.js';

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  const ok = typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : actual === expected;
  if (ok) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

function createMockStorage() {
  const store = {};
  return {
    _store: store,
    async get(keys) {
      if (keys === null) return structuredClone(store);
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
      }
      const result = {};
      for (const k of keys) {
        if (k in store) result[k] = structuredClone(store[k]);
      }
      return result;
    },
    async set(obj) {
      Object.assign(store, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete store[k];
    }
  };
}

function usageFor(storage, day) {
  return storage._store[`usage:${day}`] || {};
}

// Fake clock: tests set `t` and the manager reads it through now().
function createHarness(startTime) {
  const clock = { t: startTime };
  const storage = createMockStorage();
  const manager = createSessionManager(storage, { now: () => clock.t });
  return { clock, storage, manager };
}

console.log('\n=== getDomain() ===');
assert('normal URL', getDomain('https://www.google.com/search?q=test'), 'www.google.com');
assert('subdomain', getDomain('https://mail.google.com'), 'mail.google.com');
assert('no protocol', getDomain('http://example.com'), 'example.com');
assert('chrome:// ignored', getDomain('chrome://settings'), null);
assert('chrome-extension:// ignored', getDomain('chrome-extension://abcdefghijklmnop/page.html'), null);
assert('edge:// ignored', getDomain('edge://settings'), null);
assert('devtools:// ignored', getDomain('devtools://devtools/bundled/inspector.html'), null);
assert('about: ignored', getDomain('about:blank'), null);
assert('new-tab ignored', getDomain('new-tab-page:'), null);
assert('empty URL', getDomain(''), null);
assert('invalid URL', getDomain('not-a-url'), null);
assert('file:// has no hostname', getDomain('file:///C:/docs/page.html'), null);

console.log('\n=== getDay() ===');
const now = new Date();
const expectedToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
assert('returns local date', getDay(new Date()), expectedToday);
assert('handles midnight edge case', getDay(new Date(2024, 0, 1, 0, 0, 0)), '2024-01-01');
assert('handles noon', getDay(new Date(2024, 11, 25, 12, 0, 0)), '2024-12-25');

console.log('\n=== formatTime() ===');
assert('0ms', formatTime(0), '0s');
assert('30 seconds', formatTime(30000), '30s');
assert('59 seconds', formatTime(59999), '59s');
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

console.log('\n=== getBaseDomain() ===');
assert('www stripped', getBaseDomain('www.google.com'), 'google.com');
assert('deep subdomain', getBaseDomain('a.b.mail.google.com'), 'google.com');
assert('bare domain unchanged', getBaseDomain('google.com'), 'google.com');
assert('two-part TLD kept', getBaseDomain('news.bbc.co.uk'), 'bbc.co.uk');
assert('bare two-part TLD domain unchanged', getBaseDomain('bbc.co.uk'), 'bbc.co.uk');
assert('localhost unchanged', getBaseDomain('localhost'), 'localhost');
assert('IPv4 unchanged', getBaseDomain('192.168.1.100'), '192.168.1.100');

console.log('\n=== groupByBaseDomain() ===');
assert('merges subdomains', groupByBaseDomain({
  'www.google.com': 1000,
  'mail.google.com': 2000,
  'github.com': 500
}), { 'google.com': 3000, 'github.com': 500 });

console.log('\n=== isExcluded() ===');
assert('exact match', isExcluded('example.com', ['example.com']), true);
assert('subdomain match', isExcluded('mail.example.com', ['example.com']), true);
assert('no match', isExcluded('github.com', ['example.com']), false);
assert('suffix is not subdomain', isExcluded('notexample.com', ['example.com']), false);
assert('case insensitive', isExcluded('Example.COM', ['example.com']), true);
assert('empty list', isExcluded('example.com', []), false);
assert('null domain', isExcluded(null, ['example.com']), false);
assert('missing list', isExcluded('example.com', undefined), false);

console.log('\n=== domainHue() ===');
assert('deterministic', domainHue('github.com'), domainHue('github.com'));
{
  const hues = ['github.com', 'youtube.com', 'stackoverflow.com', 'google.com']
    .map(domainHue);
  assert('all hues in 0-359', hues.every((h) => Number.isInteger(h) && h >= 0 && h < 360), true);
  assert('different domains vary', new Set(hues).size > 1, true);
}

console.log('\n=== toCsv() ===');
{
  const csv = toCsv({
    'usage:2026-07-08': { 'b.com': 60000 },
    'usage:2026-07-07': { 'a.com': 3600000, 'weird"domain,com': 1000 }
  });
  const lines = csv.trim().split('\r\n');
  assert('header row', lines[0], 'date,domain,milliseconds,duration');
  assert('days sorted, domains by time desc', lines[1], '2026-07-07,a.com,3600000,1h 0m');
  assert('special chars quoted', lines[2], '2026-07-07,"weird""domain,com",1000,1s');
  assert('second day follows', lines[3], '2026-07-08,b.com,60000,1m');
  assert('row count', lines.length, 4);
}

console.log('\n=== appendToLog() ===');
{
  const log = [];
  appendToLog(log, { domain: 'a.com', startTime: 1000, duration: 60000 });
  assert('first entry appended', log, [[1000, 60000, 'a.com']]);

  appendToLog(log, { domain: 'a.com', startTime: 61000, duration: 60000 });
  assert('contiguous same domain coalesced', log, [[1000, 120000, 'a.com']]);

  appendToLog(log, { domain: 'a.com', startTime: 121000 + COALESCE_GAP_MS, duration: 5000 });
  assert('within-tolerance gap coalesced', log.length, 1);

  appendToLog(log, { domain: 'b.com', startTime: 200000, duration: 10000 });
  assert('different domain appended', log.length, 2);

  appendToLog(log, { domain: 'b.com', startTime: 200000 + 10000 + COALESCE_GAP_MS + 1, duration: 5000 });
  assert('over-tolerance gap appended', log.length, 3);
}
{
  const log = [];
  for (let i = 0; i < SESSION_LOG_CAP; i++) {
    appendToLog(log, { domain: `site${i}.com`, startTime: i * 10000, duration: 1000 });
  }
  appendToLog(log, { domain: 'overflow.com', startTime: SESSION_LOG_CAP * 10000, duration: 1000 });
  assert('cap stops appends', log.length, SESSION_LOG_CAP);

  const lastStart = log[log.length - 1][0];
  appendToLog(log, { domain: log[log.length - 1][2], startTime: lastStart + 1000, duration: 2000 });
  assert('cap still allows coalescing', log[log.length - 1][1], 3000);
}

console.log('\n=== Session log: written through the manager ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 60000;
  await manager.checkpointSession();
  clock.t = t0 + 120000;
  await manager.checkpointSession();
  clock.t = t0 + 150000;
  await manager.switchSession('site-b.com', 2);

  const log = storage._store['sessions:2026-07-07'];
  assert('checkpoint chunks coalesce to one entry', log, [[t0, 150000, 'site-a.com']]);
}
{
  const start = new Date(2026, 6, 7, 23, 59, 0).getTime();
  const { clock, storage, manager } = createHarness(start);

  await manager.switchSession('site-a.com', 1);
  clock.t = new Date(2026, 6, 8, 0, 1, 0).getTime();
  await manager.checkpointSession();

  assert('pre-midnight chunk in Jul 7 log', storage._store['sessions:2026-07-07'], [[start, 60000, 'site-a.com']]);
  assert('post-midnight chunk in Jul 8 log',
    storage._store['sessions:2026-07-08'],
    [[new Date(2026, 6, 8, 0, 0, 0).getTime(), 60000, 'site-a.com']]);
}

console.log('\n=== Session: switch persists previous session ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 90000;
  await manager.switchSession('site-b.com', 2);

  assert('site-a.com credited exactly 90s', usageFor(storage, '2026-07-07')['site-a.com'], 90000);
  assert('currentSession is site-b.com', manager.currentSession.domain, 'site-b.com');
  assert('currentSession tabId is 2', manager.currentSession.tabId, 2);
  assert('currentSession persisted to storage', storage._store.currentSession.domain, 'site-b.com');
}

console.log('\n=== Session: switch to null ends tracking ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 60000;
  await manager.switchSession(null, null);

  assert('site-a.com credited 60s', usageFor(storage, '2026-07-07')['site-a.com'], 60000);
  assert('no current session', manager.currentSession, null);
  assert('currentSession removed from storage', 'currentSession' in storage._store, false);
}

console.log('\n=== Session: debounce drops sub-500ms sessions ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('flicker.com', 1);
  clock.t = t0 + DEBOUNCE_MS - 1;
  await manager.switchSession('site-b.com', 2);

  assert('sub-500ms session not persisted', 'flicker.com' in usageFor(storage, '2026-07-07'), false);
}

console.log('\n=== Session: sleep gap over cap is discarded ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + SLEEP_CAP_MS + 1000;
  await manager.switchSession('site-b.com', 2);

  assert('over-cap session discarded', 'site-a.com' in usageFor(storage, '2026-07-07'), false);
  assert('new session started after gap', manager.currentSession.domain, 'site-b.com');
}

console.log('\n=== Session: gap exactly at cap is kept ===');
{
  const t0 = new Date(2026, 6, 7, 10, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + SLEEP_CAP_MS;
  await manager.switchSession(null, null);

  assert('exactly-at-cap session kept', usageFor(storage, '2026-07-07')['site-a.com'], SLEEP_CAP_MS);
}

console.log('\n=== Checkpoint: flushes and resets startTime ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 2 * CHECKPOINT_INTERVAL_MS;
  await manager.checkpointSession();

  assert('elapsed time flushed', usageFor(storage, '2026-07-07')['site-a.com'], 2 * CHECKPOINT_INTERVAL_MS);
  assert('session still running', manager.currentSession.domain, 'site-a.com');
  assert('startTime reset to now', manager.currentSession.startTime, clock.t);
}

console.log('\n=== Checkpoint: below interval is a no-op ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 30000;
  await manager.checkpointSession();

  assert('nothing flushed', 'site-a.com' in usageFor(storage, '2026-07-07'), false);
  assert('startTime unchanged', manager.currentSession.startTime, t0);
}

console.log('\n=== Checkpoint: no double count with rapid switch ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-a.com', 1);
  clock.t = t0 + 90000;
  manager.checkpointSession();
  await manager.switchSession('site-b.com', 2);

  assert('site-a.com credited exactly 90s total', usageFor(storage, '2026-07-07')['site-a.com'], 90000);
  assert('currentSession is site-b.com', manager.currentSession.domain, 'site-b.com');
}

console.log('\n=== Checkpoint: interleaved checkpoints and switches stay ordered ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { clock, storage, manager } = createHarness(t0);

  await manager.switchSession('site-x.com', 10);
  clock.t = t0 + 60000;
  manager.checkpointSession();
  manager.switchSession('site-y.com', 20);
  manager.checkpointSession();
  await manager.switchSession('site-z.com', 30);

  assert('site-x.com credited exactly 60s', usageFor(storage, '2026-07-07')['site-x.com'], 60000);
  assert('site-y.com not persisted (0ms session)', 'site-y.com' in usageFor(storage, '2026-07-07'), false);
  assert('currentSession is site-z.com', manager.currentSession.domain, 'site-z.com');
  assert('currentSession tabId is 30', manager.currentSession.tabId, 30);
}

console.log('\n=== Checkpoint: midnight crossing splits into two buckets ===');
{
  const start = new Date(2026, 6, 7, 23, 59, 0).getTime();
  const { clock, storage, manager } = createHarness(start);

  await manager.switchSession('site-a.com', 1);
  clock.t = new Date(2026, 6, 8, 0, 1, 0).getTime();
  await manager.checkpointSession();

  assert('60s in the Jul 7 bucket', usageFor(storage, '2026-07-07')['site-a.com'], 60000);
  assert('60s in the Jul 8 bucket', usageFor(storage, '2026-07-08')['site-a.com'], 60000);
  assert('startTime reset to now', manager.currentSession.startTime, clock.t);
}

console.log('\n=== Checkpoint: uneven midnight split sums to total ===');
{
  const start = new Date(2026, 6, 7, 23, 59, 30).getTime();
  const { clock, storage, manager } = createHarness(start);

  await manager.switchSession('site-a.com', 1);
  clock.t = new Date(2026, 6, 8, 0, 1, 30).getTime();
  await manager.checkpointSession();

  const before = usageFor(storage, '2026-07-07')['site-a.com'];
  const after = usageFor(storage, '2026-07-08')['site-a.com'];
  assert('30s before midnight', before, 30000);
  assert('90s after midnight', after, 90000);
  assert('split sums to elapsed', before + after, 120000);
}

console.log('\n=== Restore: recent saved session is flushed ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { storage, manager } = createHarness(t0);
  storage._store.currentSession = { domain: 'old.com', tabId: 5, startTime: t0 - 90000 };

  await manager.restoreSession();

  assert('saved session credited 90s', usageFor(storage, '2026-07-07')['old.com'], 90000);
  assert('no current session after restore', manager.currentSession, null);
  assert('currentSession removed from storage', 'currentSession' in storage._store, false);
}

console.log('\n=== Restore: stale saved session is discarded ===');
{
  const t0 = new Date(2026, 6, 7, 14, 0, 0).getTime();
  const { storage, manager } = createHarness(t0);
  storage._store.currentSession = { domain: 'old.com', tabId: 5, startTime: t0 - 4 * 60 * 60 * 1000 };

  await manager.restoreSession();

  assert('stale session not credited', 'old.com' in usageFor(storage, '2026-07-07'), false);
  assert('currentSession removed from storage', 'currentSession' in storage._store, false);
}

console.log('\n=== getPruneKeys() ===');
{
  const today = new Date(2026, 6, 15);
  const keys = [
    'usage:2026-07-15',
    'usage:2026-04-16',
    'usage:2026-04-15',
    'usage:2025-01-01',
    'settings',
    'currentSession'
  ];

  const pruned = getPruneKeys(keys, 90, today);
  assert('prunes only expired usage keys', pruned, ['usage:2026-04-15', 'usage:2025-01-01']);

  assert('exact cutoff day is kept', getPruneKeys(['usage:2026-07-08'], 7, today), []);
  assert('day before cutoff is pruned', getPruneKeys(['usage:2026-07-07'], 7, today), ['usage:2026-07-07']);
  assert('expired session logs pruned too', getPruneKeys(['sessions:2026-04-15', 'sessions:2026-07-14'], 90, today), ['sessions:2026-04-15']);
  assert('non-usage keys never pruned', getPruneKeys(['settings', 'currentSession'], 1, today), []);
  assert('malformed usage key kept', getPruneKeys(['usage:not-a-date'], 90, today), []);
}

console.log('\n=== computeVisits() ===');
{
  const log = [
    [1000, 60000, 'a.com'],
    [70000, 30000, 'b.com'],
    [110000, 90000, 'a.com']
  ];
  assert('counts and sums per domain', computeVisits(log), {
    'a.com': { count: 2, totalMs: 150000 },
    'b.com': { count: 1, totalMs: 30000 }
  });
  assert('empty log', computeVisits([]), {});
}

console.log('\n=== longestSession() ===');
{
  const log = [[0, 60000, 'a.com'], [70000, 300000, 'b.com'], [400000, 5000, 'c.com']];
  assert('finds longest entry', longestSession(log), [70000, 300000, 'b.com']);
  assert('empty log returns null', longestSession([]), null);
}

console.log('\n=== pickInsight() ===');
{
  const MIN = 60000;
  const focusLog = [[0, 30 * MIN, 'github.com'], [31 * MIN, 2 * MIN, 'twitter.com']];
  assert('focus stretch rule',
    pickInsight({ log: focusLog, today: {}, lastWeek: {} }),
    'Longest focus stretch today: 30m on github.com');

  const habitLog = [];
  for (let i = 0; i < 25; i++) habitLog.push([i * 5 * MIN, 40 * 1000, 'twitter.com']);
  assert('checking habit rule',
    pickInsight({ log: habitLog, today: {}, lastWeek: {} }),
    "You've opened twitter.com 25 times today");

  assert('focus stretch beats habit',
    pickInsight({ log: focusLog.concat(habitLog), today: {}, lastWeek: {} }),
    'Longest focus stretch today: 30m on github.com');

  assert('upward trend rule',
    pickInsight({ log: [], today: { 'youtube.com': 60 * MIN }, lastWeek: { 'youtube.com': 30 * MIN } }),
    'youtube.com: 100% more than this day last week');

  assert('downward trend rule',
    pickInsight({ log: [], today: { 'youtube.com': 15 * MIN }, lastWeek: { 'youtube.com': 60 * MIN } }),
    'youtube.com: 75% less than this day last week');

  assert('small change stays silent',
    pickInsight({ log: [], today: { 'youtube.com': 33 * MIN }, lastWeek: { 'youtube.com': 30 * MIN } }),
    null);

  assert('trend needs both days above threshold',
    pickInsight({ log: [], today: { 'youtube.com': 9 * MIN }, lastWeek: { 'youtube.com': 3 * MIN } }),
    null);

  assert('nothing to say returns null',
    pickInsight({ log: [[0, 2 * MIN, 'a.com']], today: { 'a.com': 2 * MIN }, lastWeek: {} }),
    null);

  assert('no inputs returns null', pickInsight(), null);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
