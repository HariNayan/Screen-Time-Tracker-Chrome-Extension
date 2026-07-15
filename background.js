import { getDomain, getPruneKeys, isExcluded } from './lib.js';
import { createSessionManager, CHECKPOINT_INTERVAL_MS } from './session.js';

const IDLE_DETECTION_INTERVAL = 60;
const IDLE_MIN_INTERVAL = 15;
const PRUNE_DAYS = 90;
const DEFAULT_SETTINGS = { idleThreshold: 60, retentionDays: 90, excludedDomains: [] };

const manager = createSessionManager(chrome.storage.local);
let isIdle = false;
let cachedSettings = DEFAULT_SETTINGS;

async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  cachedSettings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
  return cachedSettings;
}

function idleInterval(settings) {
  return Math.max(settings.idleThreshold || IDLE_DETECTION_INTERVAL, IDLE_MIN_INTERVAL);
}

function resolveDomain(url) {
  const domain = getDomain(url);
  if (isExcluded(domain, cachedSettings.excludedDomains)) return null;
  return domain;
}

async function handleTabActivation(tab) {
  if (isIdle) return;

  try {
    if (tab && tab.url) {
      await manager.switchSession(resolveDomain(tab.url), tab.id);
    }
  } catch (e) {
    console.error('Error handling tab activation:', e);
  }
}

async function handleTabUpdate(tabId, changeInfo, tab) {
  if (isIdle) return;
  if (changeInfo.status !== 'complete') return;

  try {
    if (tab && tab.url) {
      await manager.switchSession(resolveDomain(tab.url), tabId);
    }
  } catch (e) {
    console.error('Error handling tab update:', e);
  }
}

async function handleWindowFocusChanged(windowId) {
  if (isIdle) return;

  try {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await manager.switchSession(null, null);
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs && tabs[0] && tabs[0].url) {
      await manager.switchSession(resolveDomain(tabs[0].url), tabs[0].id);
    }
  } catch (e) {
    console.error('Error handling window focus change:', e);
  }
}

async function handleTabRemoved(tabId) {
  const session = manager.currentSession;
  if (session && session.tabId === tabId) {
    try {
      await manager.switchSession(null, null);
    } catch (e) {
      console.error('Error handling tab removal:', e);
    }
  }
}

async function pruneOldData() {
  try {
    const settings = await getSettings();
    const allData = await chrome.storage.local.get(null);
    const keysToRemove = getPruneKeys(
      Object.keys(allData),
      settings.retentionDays || PRUNE_DAYS
    );

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (e) {
    console.error('Error pruning old data:', e);
  }
}

async function applySettings() {
  try {
    const settings = await getSettings();
    chrome.idle.setDetectionInterval(idleInterval(settings));
  } catch (e) {
    console.error('Failed to apply settings:', e);
  }
}

applySettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.settings) {
    applySettings();
  }
});

chrome.idle.onStateChanged.addListener(async (newState) => {
  try {
    if (newState === 'idle' || newState === 'locked') {
      isIdle = true;
      await manager.switchSession(null, null);
    } else if (newState === 'active') {
      isIdle = false;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].url) {
        await manager.switchSession(resolveDomain(tabs[0].url), tabs[0].id);
      }
    }
  } catch (e) {
    console.error('Error handling idle state change:', e);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting tab:', chrome.runtime.lastError);
      return;
    }
    handleTabActivation(tab);
  });
});

chrome.tabs.onUpdated.addListener(handleTabUpdate);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.windows.onFocusChanged.addListener(handleWindowFocusChanged);

chrome.alarms.get('pruneOldData').then((alarm) => {
  if (!alarm) {
    chrome.alarms.create('pruneOldData', { periodInMinutes: 1440 });
  }
});
chrome.alarms.get('sessionCheckpoint').then((alarm) => {
  if (!alarm) {
    chrome.alarms.create('sessionCheckpoint', {
      periodInMinutes: CHECKPOINT_INTERVAL_MS / 60000
    });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pruneOldData') {
    pruneOldData();
  } else if (alarm.name === 'sessionCheckpoint') {
    if (!isIdle) {
      manager.checkpointSession();
    }
  }
});

(async () => {
  try {
    await manager.restoreSession();

    // A restarted worker loses the in-memory idle flag, and onStateChanged
    // only fires on transitions — if the user is still idle, no event will
    // arrive to tell us. Query the state before starting a new session.
    const settings = await getSettings();
    const state = await chrome.idle.queryState(idleInterval(settings));
    isIdle = state !== 'active';
    if (isIdle) return;

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) {
      await manager.switchSession(resolveDomain(tabs[0].url), tabs[0].id);
    }
  } catch (e) {
    console.error('Error initializing session:', e);
  }
})();
