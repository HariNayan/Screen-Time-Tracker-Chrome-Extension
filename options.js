const DEFAULT_SETTINGS = {
  idleThreshold: 60,
  retentionDays: 90,
  theme: 'light',
  groupSubdomains: false,
  excludedDomains: []
};

const LIMITS = {
  idleThreshold: { min: 15, max: 300 },
  retentionDays: { min: 7, max: 365 }
};

function clamp(value, { min, max }) {
  return Math.min(Math.max(value, min), max);
}

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.settings || {}) });
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings }, resolve);
  });
}

function showStatus() {
  const status = document.getElementById('status');
  status.classList.add('show');
  setTimeout(() => {
    status.classList.remove('show');
  }, 2000);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('theme-toggle');
  toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();

  applyTheme(settings.theme);

  document.getElementById('idle-threshold').value = settings.idleThreshold;
  document.getElementById('retention-days').value = settings.retentionDays;
  document.getElementById('group-subdomains').checked = Boolean(settings.groupSubdomains);
  document.getElementById('excluded-domains').value = (settings.excludedDomains || []).join('\n');

  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const current = settings.theme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    settings.theme = next;
    await saveSettings(settings);
    applyTheme(next);
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const excludedDomains = [...new Set(
      document.getElementById('excluded-domains').value
        .split('\n')
        .map((line) => line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter((line) => line !== '')
    )];

    const newSettings = {
      ...settings,
      idleThreshold: clamp(parseInt(document.getElementById('idle-threshold').value, 10) || DEFAULT_SETTINGS.idleThreshold, LIMITS.idleThreshold),
      retentionDays: clamp(parseInt(document.getElementById('retention-days').value, 10) || DEFAULT_SETTINGS.retentionDays, LIMITS.retentionDays),
      groupSubdomains: document.getElementById('group-subdomains').checked,
      excludedDomains
    };

    Object.assign(settings, newSettings);
    await saveSettings(settings);

    document.getElementById('idle-threshold').value = newSettings.idleThreshold;
    document.getElementById('retention-days').value = newSettings.retentionDays;
    document.getElementById('excluded-domains').value = newSettings.excludedDomains.join('\n');

    showStatus();
  });
});
