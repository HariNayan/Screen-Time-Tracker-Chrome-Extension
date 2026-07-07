let currentView = 'today';
let refreshTimeout = null;
let themeTimeout = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getDayKey(date) {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
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

async function getData() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      if (currentView === 'today') {
        const todayKey = `usage:${getDayKey(new Date())}`;
        resolve({ type: 'single', data: result[todayKey] || {} });
      } else {
        const days = getLast7Days();
        const weekData = {};
        for (const day of days) {
          const key = `usage:${day}`;
          weekData[day] = result[key] || {};
        }
        resolve({ type: 'week', data: weekData });
      }
    });
  });
}

function renderSingleDay(data) {
  const listEl = document.getElementById('domain-list');
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const totalMs = entries.reduce((sum, [, time]) => sum + time, 0);
  const siteCount = entries.length;

  document.getElementById('total-time').textContent = formatTime(totalMs);
  document.getElementById('site-count').textContent = siteCount;
  document.getElementById('date-range').textContent = `Showing: ${getDayKey(new Date())}`;

  if (entries.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No data yet. Start browsing!</p>';
    return;
  }

  const maxTime = entries[0][1];

  listEl.innerHTML = entries
    .map(([domain, time]) => {
      const percent = maxTime > 0 ? (time / maxTime) * 100 : 0;
      return `
        <div class="domain-item">
          <div class="domain-info">
            <div class="domain-name">${escapeHtml(domain)}</div>
            <div class="domain-bar-container">
              <div class="domain-bar" style="width: ${percent}%"></div>
            </div>
          </div>
          <div class="domain-time">${formatTime(time)}</div>
        </div>
      `;
    })
    .join('');
}

function renderWeekData(weekData) {
  const listEl = document.getElementById('domain-list');
  const days = getLast7Days();

  let totalMs = 0;
  let totalSites = new Set();
  const daySections = [];

  for (const day of days) {
    const dayData = weekData[day] || {};
    const entries = Object.entries(dayData).sort((a, b) => b[1] - a[1]);
    const dayTotal = entries.reduce((sum, [, time]) => sum + time, 0);

    if (entries.length === 0) continue;

    totalMs += dayTotal;
    entries.forEach(([domain]) => totalSites.add(domain));

    const maxTime = entries[0][1];

    const domainItems = entries
      .map(([domain, time]) => {
        const percent = maxTime > 0 ? (time / maxTime) * 100 : 0;
        return `
          <div class="domain-item">
            <div class="domain-info">
              <div class="domain-name">${escapeHtml(domain)}</div>
              <div class="domain-bar-container">
                <div class="domain-bar" style="width: ${percent}%"></div>
              </div>
            </div>
            <div class="domain-time">${formatTime(time)}</div>
          </div>
        `;
      })
      .join('');

    daySections.push(`
      <div class="day-section">
        <div class="day-header">
          <span class="day-label">${getDayLabel(day)}</span>
          <span class="day-total">${formatTime(dayTotal)}</span>
        </div>
        <div class="day-domains">${domainItems}</div>
      </div>
    `);
  }

  document.getElementById('total-time').textContent = formatTime(totalMs);
  document.getElementById('site-count').textContent = totalSites.size;

  const start = new Date();
  start.setDate(start.getDate() - 6);
  document.getElementById('date-range').textContent =
    `Showing: ${getDayKey(start)} to ${getDayKey(new Date())}`;

  if (daySections.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No data yet. Start browsing!</p>';
    return;
  }

  listEl.innerHTML = daySections.join('');
}

async function refresh() {
  try {
    const result = await getData();
    if (result.type === 'single') {
      renderSingleDay(result.data);
    } else {
      renderWeekData(result.data);
    }
  } catch (e) {
    console.error('Failed to refresh data:', e);
  }
}

function debouncedRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(refresh, 100);
}

function setupToggle() {
  const btnToday = document.getElementById('btn-today');
  const btnWeek = document.getElementById('btn-week');

  btnToday.addEventListener('click', () => {
    currentView = 'today';
    btnToday.classList.add('active');
    btnWeek.classList.remove('active');
    refresh();
  });

  btnWeek.addEventListener('click', () => {
    currentView = 'week';
    btnWeek.classList.add('active');
    btnToday.classList.remove('active');
    refresh();
  });
}

function setupExport() {
  document.getElementById('btn-export').addEventListener('click', async () => {
    try {
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

      const blob = new Blob([JSON.stringify(usageData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      chrome.downloads.download({
        url: url,
        filename: 'site-time-tracker-data.json',
        saveAs: true
      }, () => {
        URL.revokeObjectURL(url);
      });
    } catch (e) {
      console.error('Export failed:', e);
    }
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
  const theme = await loadTheme();
  await applyTheme(theme);

  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  setupToggle();
  setupExport();
  setupClear();
  setupStorageListener();
  refresh();
});
