const DEFAULT_SETTINGS = {
  idleThreshold: 60,
  retentionDays: 90,
  theme: 'light'
};

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

  document.getElementById('theme-toggle').addEventListener('click', async () => {
    const current = settings.theme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    settings.theme = next;
    await saveSettings(settings);
    applyTheme(next);
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const newSettings = {
      ...settings,
      idleThreshold: Math.max(parseInt(document.getElementById('idle-threshold').value, 10) || DEFAULT_SETTINGS.idleThreshold, 15),
      retentionDays: Math.max(parseInt(document.getElementById('retention-days').value, 10) || DEFAULT_SETTINGS.retentionDays, 7)
    };

    await saveSettings(newSettings);
    showStatus();
  });
});
