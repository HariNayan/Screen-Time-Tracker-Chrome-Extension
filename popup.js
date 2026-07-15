import { getDay as getDayKey, formatTime, escapeHtml, groupByBaseDomain, getBaseDomain, domainHue, toCsv } from './lib.js';
import { SLEEP_CAP_MS } from './session.js';

let currentView = 'today';
let refreshTimeout = null;
let themeTimeout = null;

// Rebuilding innerHTML kills any open hover tooltip, so only touch the DOM
// when the rendered markup actually changed.
function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el.dataset.lastHtml !== html) {
    el.innerHTML = html;
    el.dataset.lastHtml = html;
    bindFaviconFallbacks(el);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el.textContent !== text) el.textContent = text;
}

function getDayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - d) / 86400000);

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';

  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function getLast7Days() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push(getDayKey(date));
  }
  return days;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      resolve(result.settings || {});
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

async function loadTheme() {
  const settings = await getSettings();
  return settings.theme || 'light';
}

async function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('theme-toggle');
  toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

async function toggleTheme() {
  const current = await loadTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  const settings = await getSettings();
  settings.theme = next;
  await saveSettings(settings);
  await applyTheme(next);
}

// The stored buckets only contain flushed chunks; the in-progress session's
// elapsed time lives in currentSession and would otherwise not show until the
// next checkpoint.
function withLiveSession(dayData, currentSession, dayKey) {
  if (!currentSession || !currentSession.domain) return dayData;
  const elapsed = Date.now() - currentSession.startTime;
  if (elapsed <= 0 || elapsed > SLEEP_CAP_MS) return dayData;
  if (getDayKey(new Date(currentSession.startTime)) !== dayKey) return dayData;

  const merged = { ...dayData };
  merged[currentSession.domain] = (merged[currentSession.domain] || 0) + elapsed;
  return merged;
}

function getLiveDomain(currentSession, settings) {
  if (!currentSession || !currentSession.domain) return null;
  const elapsed = Date.now() - currentSession.startTime;
  if (elapsed <= 0 || elapsed > SLEEP_CAP_MS) return null;
  return settings.groupSubdomains ? getBaseDomain(currentSession.domain) : currentSession.domain;
}

async function getData() {
  const days = currentView === 'today' ? [getDayKey(new Date())] : getLast7Days();
  const keys = days.map((day) => `usage:${day}`).concat(['currentSession', 'settings']);

  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      const settings = result.settings || {};
      const liveDomain = getLiveDomain(result.currentSession, settings);
      const transform = (dayData, day) => {
        let data = withLiveSession(dayData, result.currentSession, day);
        if (settings.groupSubdomains) data = groupByBaseDomain(data);
        return data;
      };

      if (currentView === 'today') {
        resolve({ type: 'single', data: transform(result[`usage:${days[0]}`] || {}, days[0]), liveDomain });
      } else {
        const weekData = {};
        for (const day of days) {
          weekData[day] = transform(result[`usage:${day}`] || {}, day);
        }
        resolve({ type: 'week', data: weekData, liveDomain });
      }
    });
  });
}

function monogramHtml(domain) {
  const letter = (getBaseDomain(domain) || domain).charAt(0).toUpperCase() || '?';
  const hue = domainHue(domain);
  return `<span class="domain-favicon" style="background: hsl(${hue}, 45%, 48%)">${escapeHtml(letter)}</span>`;
}

function faviconUrl(domain) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', `https://${domain}/`);
  url.searchParams.set('size', '32');
  return url.toString();
}

// Real favicons come from Chrome's local _favicon cache (no network). The
// API needs the "favicon" permission and Chrome 104+; browsers without it
// get monogram tiles instead of broken images.
let faviconSupported = false;

async function detectFaviconSupport() {
  try {
    const response = await fetch(faviconUrl('example.com'));
    faviconSupported = response.ok;
  } catch {
    faviconSupported = false;
  }
}

function iconHtml(domain) {
  if (!faviconSupported) return monogramHtml(domain);
  return `<img class="domain-favicon" data-domain="${escapeHtml(domain)}" src="${escapeHtml(faviconUrl(domain))}" alt="">`;
}

// Favicons drawn for dark browser tabs are white glyphs on transparency and
// disappear on the white cards (near-black ones do the same on dark cards).
// Measure the icon's average luminance and back only the extreme ones with a
// contrasting chip.
function classifyIconContrast(img) {
  try {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 32) continue;
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      count++;
    }
    if (count === 0) return;

    const avg = sum / count;
    if (avg > 200) img.classList.add('icon-light');
    else if (avg < 55) img.classList.add('icon-dark');
  } catch {
    // Canvas readback failed — leave the icon unbacked.
  }
}

function bindFaviconFallbacks(root) {
  root.querySelectorAll('img.domain-favicon:not([data-fallback-bound])').forEach((img) => {
    img.dataset.fallbackBound = '1';
    img.addEventListener('error', () => {
      const tpl = document.createElement('template');
      tpl.innerHTML = monogramHtml(img.dataset.domain || '?').trim();
      img.replaceWith(tpl.content.firstChild);
    }, { once: true });

    if (img.complete && img.naturalWidth > 0) {
      classifyIconContrast(img);
    } else {
      img.addEventListener('load', () => classifyIconContrast(img), { once: true });
    }
  });
}

function renderDomainItems(entries, maxTime, dayTotal, liveDomain) {
  return entries
    .map(([domain, time]) => {
      const barPercent = maxTime > 0 ? (time / maxTime) * 100 : 0;
      const share = dayTotal > 0 ? Math.round((time / dayTotal) * 100) : 0;
      const isLive = domain === liveDomain;
      const tooltip = `${escapeHtml(domain)} — ${share}% of this day${isLive ? ' · tracking now' : ''}`;
      return `
        <div class="domain-item" title="${tooltip}">
          ${iconHtml(domain)}
          <div class="domain-info">
            <div class="domain-name">${escapeHtml(domain)}${isLive ? '<span class="live-dot"></span>' : ''}</div>
            <div class="domain-bar-container">
              <div class="domain-bar" style="width: ${barPercent}%"></div>
            </div>
          </div>
          <div class="domain-time">${formatTime(time)}</div>
        </div>
      `;
    })
    .join('');
}

const EMPTY_STATE_HTML =
  '<p class="empty-state"><span class="empty-icon">⏳</span>No data yet. Start browsing!</p>';

const DONUT_RADIUS = 48;
const DONUT_GAP = 3;

function renderDonutSvg(segments) {
  const circumference = 2 * Math.PI * DONUT_RADIUS;
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return '';

  const useGap = segments.length > 1;
  let start = 0;
  const circles = segments
    .map((seg) => {
      const len = (seg.value / total) * circumference;
      const visible = useGap ? Math.max(len - DONUT_GAP, 0.5) : len;
      const circle = `<circle cx="60" cy="60" r="${DONUT_RADIUS}"
        stroke="${seg.color}"
        stroke-dasharray="${visible.toFixed(2)} ${(circumference - visible).toFixed(2)}"
        stroke-dashoffset="${(-start).toFixed(2)}"></circle>`;
      start += len;
      return circle;
    })
    .join('');

  return `<svg class="donut" viewBox="0 0 120 120" aria-hidden="true">
    <g transform="rotate(-90 60 60)">${circles}</g>
  </svg>`;
}

function renderTopSites(data) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const card = document.getElementById('top-card');

  if (entries.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const top = entries.slice(0, 5);
  const otherMs = entries.slice(5).reduce((sum, [, time]) => sum + time, 0);

  const segments = top.map(([domain, time], i) => ({
    value: time,
    color: `var(--cat-${i + 1})`,
    domain
  }));
  if (otherMs > 0) {
    segments.push({ value: otherMs, color: 'var(--cat-other)', domain: 'Other' });
  }

  const legendItems = top
    .map(([domain, time]) =>
      `<li title="${escapeHtml(domain)}">
        ${iconHtml(domain)}
        <span class="top-name">${escapeHtml(domain)}</span>
        <span class="top-time">${formatTime(time)}</span>
      </li>`
    )
    .join('');

  const count = entries.length;
  setHtml('top-sites', `
    <div class="donut-wrap">
      ${renderDonutSvg(segments)}
      <div class="donut-center">
        <span class="donut-count">${count}</span>
        <span class="donut-label">Website${count === 1 ? '' : 's'}</span>
      </div>
    </div>
    <ul class="top-list">${legendItems}</ul>
  `);
}

function renderSingleDay(data, liveDomain) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const totalMs = entries.reduce((sum, [, time]) => sum + time, 0);

  setText('hero-title', "Today's Activity");
  setText('total-time', formatTime(totalMs));
  setText('list-title', "Today's Activity");
  setText('date-range', getDayKey(new Date()));

  renderTopSites(data);

  if (entries.length === 0) {
    setHtml('domain-list', EMPTY_STATE_HTML);
    return;
  }

  setHtml('domain-list', renderDomainItems(entries, entries[0][1], totalMs, liveDomain));
}

function renderWeekChart(days, weekData) {
  const chartDays = [...days].reverse();
  const totals = chartDays.map((day) =>
    Object.values(weekData[day] || {}).reduce((sum, t) => sum + t, 0)
  );
  const maxTotal = Math.max(...totals, 1);
  const todayKey = getDayKey(new Date());

  const columns = chartDays
    .map((day, i) => {
      const total = totals[i];
      const heightPercent = (total / maxTotal) * 100;
      const initial = new Date(day + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday: 'narrow' });
      const isToday = day === todayKey;
      return `
        <div class="chart-col${isToday ? ' today' : ''}"
             title="${escapeHtml(getDayLabel(day))}: ${formatTime(total)}">
          <div class="chart-track">
            <div class="chart-bar" style="height: ${heightPercent}%"></div>
          </div>
          <span class="chart-day">${escapeHtml(initial)}</span>
        </div>
      `;
    })
    .join('');

  return `<div class="week-chart" role="img" aria-label="Daily total time, last 7 days">${columns}</div>`;
}

function renderWeekData(weekData, liveDomain) {
  const days = getLast7Days();
  const todayKey = getDayKey(new Date());

  let totalMs = 0;
  const weekAggregate = {};
  const daySections = [];

  for (const day of days) {
    const dayData = weekData[day] || {};
    const entries = Object.entries(dayData).sort((a, b) => b[1] - a[1]);
    const dayTotal = entries.reduce((sum, [, time]) => sum + time, 0);

    if (entries.length === 0) continue;

    totalMs += dayTotal;
    for (const [domain, time] of entries) {
      weekAggregate[domain] = (weekAggregate[domain] || 0) + time;
    }

    const dayLive = day === todayKey ? liveDomain : null;
    daySections.push(`
      <div class="day-section">
        <div class="day-header">
          <span class="day-label">${getDayLabel(day)}</span>
          <span class="day-total">${formatTime(dayTotal)}</span>
        </div>
        <div class="day-domains">${renderDomainItems(entries, entries[0][1], dayTotal, dayLive)}</div>
      </div>
    `);
  }

  setText('hero-title', "This Week's Activity");
  setText('total-time', formatTime(totalMs));
  setText('list-title', 'Daily Breakdown');

  const start = new Date();
  start.setDate(start.getDate() - 6);
  setText('date-range', `${getDayKey(start)} – ${todayKey}`);

  renderTopSites(weekAggregate);

  if (daySections.length === 0) {
    setHtml('domain-list', EMPTY_STATE_HTML);
    return;
  }

  setHtml('domain-list', renderWeekChart(days, weekData) + daySections.join(''));
}

async function refresh() {
  try {
    const result = await getData();
    if (result.type === 'single') {
      renderSingleDay(result.data, result.liveDomain);
    } else {
      renderWeekData(result.data, result.liveDomain);
    }
  } catch (e) {
    console.error('Failed to refresh data:', e);
  }
}

function debouncedRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(refresh, 100);
}

function setupViewToggle() {
  const btn = document.getElementById('btn-view');
  btn.addEventListener('click', () => {
    currentView = currentView === 'today' ? 'week' : 'today';
    setText('btn-view-label', currentView === 'today' ? 'This Week' : 'Today');
    refresh();
  });
}

async function getAllUsageData() {
  const allData = await new Promise((resolve, reject) => {
    chrome.storage.local.get(null, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result);
    });
  });

  const usageData = {};
  for (const [key, value] of Object.entries(allData)) {
    if (key.startsWith('usage:')) {
      usageData[key] = value;
    }
  }
  return usageData;
}

// A data URL survives the popup closing; a blob URL from the popup
// becomes invalid once the popup document is destroyed.
async function exportAs(format) {
  try {
    const usageData = await getAllUsageData();

    let content, mime, filename;
    if (format === 'csv') {
      content = toCsv(usageData);
      mime = 'text/csv';
      filename = 'site-time-tracker-data.csv';
    } else {
      content = JSON.stringify(usageData, null, 2);
      mime = 'application/json';
      filename = 'site-time-tracker-data.json';
    }

    const url = `data:${mime};charset=utf-8,` + encodeURIComponent(content);
    await chrome.downloads.download({ url, filename, saveAs: true });
  } catch (e) {
    console.error('Export failed:', e);
  }
}

function setupExport() {
  const menu = document.getElementById('export-menu');
  document.getElementById('btn-export').addEventListener('click', () => {
    menu.hidden = !menu.hidden;
  });
  document.getElementById('btn-export-json').addEventListener('click', () => {
    menu.hidden = true;
    exportAs('json');
  });
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    menu.hidden = true;
    exportAs('csv');
  });
}

function setupClear() {
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all tracking data? This cannot be undone.')) {
      chrome.storage.local.get(null, (result) => {
        const keysToRemove = Object.keys(result).filter(k => k.startsWith('usage:'));
        chrome.storage.local.remove(keysToRemove, () => {
          if (chrome.runtime.lastError) {
            console.error('Clear failed:', chrome.runtime.lastError);
          }
          refresh();
        });
      });
    }
  });
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      const hasUsageChange = Object.keys(changes).some(k => k.startsWith('usage:'));
      if (hasUsageChange) {
        debouncedRefresh();
      }
      if (changes.settings && changes.settings.newValue && changes.settings.newValue.theme) {
        if (themeTimeout) clearTimeout(themeTimeout);
        themeTimeout = setTimeout(() => {
          applyTheme(changes.settings.newValue.theme);
        }, 50);
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await detectFaviconSupport();
  const theme = await loadTheme();
  await applyTheme(theme);

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  setupViewToggle();
  setupExport();
  setupClear();
  setupStorageListener();
  refresh();

  // Tick so the in-progress session's time counts up while the popup is
  // open. The week view ticks slower — its second-by-second changes are
  // barely visible and a rebuild would dismiss an open chart tooltip.
  let tick = 0;
  setInterval(() => {
    tick++;
    if (currentView === 'today' || tick % 5 === 0) refresh();
  }, 1000);
});
