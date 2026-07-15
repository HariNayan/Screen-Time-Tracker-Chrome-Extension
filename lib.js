export const IGNORED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'devtools://',
  'about:',
  'new-tab-page:'
];

export function getDomain(url) {
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

export function getDay(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSeconds}s`;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Common two-part public suffixes. Not the full Public Suffix List — that is
// ~10k entries; this covers the overwhelming majority of real browsing.
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in',
  'co.kr', 'or.kr', 'go.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'org.mx', 'gob.mx',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.sg', 'edu.sg', 'gov.sg',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.ar', 'com.tr', 'com.hk', 'com.my', 'com.ph', 'com.vn',
  'co.id', 'co.th', 'co.il', 'com.eg', 'com.sa', 'com.pk'
]);

export function getBaseDomain(hostname) {
  if (!hostname) return hostname;
  if (hostname.includes(':') || /^[\d.]+$/.test(hostname)) return hostname;
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  const keep = TWO_PART_TLDS.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export function groupByBaseDomain(dayData) {
  const grouped = {};
  for (const [domain, ms] of Object.entries(dayData)) {
    const base = getBaseDomain(domain);
    grouped[base] = (grouped[base] || 0) + ms;
  }
  return grouped;
}

export function isExcluded(domain, excludedDomains) {
  if (!domain || !Array.isArray(excludedDomains)) return false;
  const d = domain.toLowerCase();
  return excludedDomains.some((raw) => {
    const excluded = String(raw).trim().toLowerCase();
    return excluded !== '' && (d === excluded || d.endsWith('.' + excluded));
  });
}

// Deterministic hue per domain so its monogram tile keeps the same color
// across renders and sessions.
export function domainHue(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function csvEscape(value) {
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function toCsv(usageData) {
  const rows = [['date', 'domain', 'milliseconds', 'duration']];
  for (const key of Object.keys(usageData).sort()) {
    const day = key.slice('usage:'.length);
    const entries = Object.entries(usageData[key]).sort((a, b) => b[1] - a[1]);
    for (const [domain, ms] of entries) {
      rows.push([day, domain, String(ms), formatTime(ms)]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// log: array of [startMs, durationMs, domain] session entries
export function computeVisits(log) {
  const visits = {};
  for (const [, duration, domain] of log) {
    const v = visits[domain] || (visits[domain] = { count: 0, totalMs: 0 });
    v.count++;
    v.totalMs += duration;
  }
  return visits;
}

export function longestSession(log) {
  let best = null;
  for (const entry of log) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

const FOCUS_STRETCH_MIN_MS = 25 * 60 * 1000;
const HABIT_MIN_COUNT = 20;
const HABIT_MAX_AVG_MS = 2 * 60 * 1000;
const TREND_MIN_MS = 10 * 60 * 1000;

// One observation for the popup, or null when nothing is worth saying.
// Rules are ordered: a real focus stretch beats a checking habit beats a
// week-over-week trend, and each has a threshold so the line stays quiet
// rather than stating something trivial.
export function pickInsight({ log = [], today = {}, lastWeek = {} } = {}) {
  const best = longestSession(log);
  if (best && best[1] >= FOCUS_STRETCH_MIN_MS) {
    return `Longest focus stretch today: ${formatTime(best[1])} on ${best[2]}`;
  }

  const visits = computeVisits(log);
  let habit = null;
  for (const [domain, v] of Object.entries(visits)) {
    if (v.count >= HABIT_MIN_COUNT && v.totalMs / v.count < HABIT_MAX_AVG_MS && (!habit || v.count > habit.count)) {
      habit = { domain, count: v.count };
    }
  }
  if (habit) {
    return `You've opened ${habit.domain} ${habit.count} times today`;
  }

  const entries = Object.entries(today).sort((a, b) => b[1] - a[1]);
  if (entries.length > 0) {
    const [domain, ms] = entries[0];
    const prev = lastWeek[domain] || 0;
    if (ms >= TREND_MIN_MS && prev >= TREND_MIN_MS) {
      const ratio = ms / prev;
      if (ratio >= 1.5) return `${domain}: ${Math.round((ratio - 1) * 100)}% more than this day last week`;
      if (ratio <= 0.67) return `${domain}: ${Math.round((1 - ratio) * 100)}% less than this day last week`;
    }
  }

  return null;
}

const DATED_KEY_RE = /^(?:usage|sessions):(\d{4}-\d{2}-\d{2})$/;

export function getPruneKeys(keys, retentionDays, today = new Date()) {
  const cutoffDate = new Date(today);
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  cutoffDate.setHours(0, 0, 0, 0);

  return keys.filter((key) => {
    const match = DATED_KEY_RE.exec(key);
    if (!match) return false;
    const date = new Date(match[1] + 'T00:00:00');
    return date < cutoffDate;
  });
}
