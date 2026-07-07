let currentSession = null;
let isIdle = false;
let sessionQueue = Promise.resolve();

const IGNORED_PREFIXES = ['chrome://', 'about:', 'new-tab-page:'];
const DEBOUNCE_MS = 500;
const IDLE_DETECTION_INTERVAL = 60;
const IDLE_MIN_INTERVAL = 15;
const PRUNE_DAYS = 90;
const SLEEP_CAP_MS = 30 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

function getDomain(url) {
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

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      resolve(result.settings || { idleThreshold: 60, retentionDays: 90 });
    });
  });
}

async function persistSession(session) {
  if (!session || session.duration < DEBOUNCE_MS) return;

  const day = getDay(new Date(session.startTime));
  const key = `usage:${day}`;

  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const dayData = result[key] || {};
      dayData[session.domain] = (dayData[session.domain] || 0) + session.duration;
      chrome.storage.local.set({ [key]: dayData }, resolve);
    });
  });
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
          const chunk = {
            domain: currentSession.domain,
            startTime: currentSession.startTime,
            duration: elapsed
          };
          await persistSession(chunk);
        } else {
          const midnight = new Date(now);
          midnight.setHours(0, 0, 0, 0);
          const firstChunkDuration = midnight.getTime() - currentSession.startTime;
          const secondChunkDuration = now - midnight.getTime();

          if (firstChunkDuration > 0) {
            await persistSession({
              domain: currentSession.domain,
              startTime: currentSession.startTime,
              duration: firstChunkDuration
            });
          }
          if (secondChunkDuration > 0) {
            await persistSession({
              domain: currentSession.domain,
              startTime: midnight.getTime(),
              duration: secondChunkDuration
            });
          }
        }

        currentSession.startTime = now;
        await chrome.storage.local.set({ currentSession });
      }
    } catch (e) {
      console.error('Error checkpointing session:', e);
    }
  });
  return sessionQueue;
}

async function endCurrentSession() {
  if (!currentSession) return;

  const now = Date.now();
  const duration = now - currentSession.startTime;

  if (duration > SLEEP_CAP_MS) {
    currentSession = null;
    await chrome.storage.local.remove('currentSession');
    return;
  }

  const sessionToSave = { ...currentSession, duration };
  currentSession = null;
  await chrome.storage.local.remove('currentSession');
  await persistSession(sessionToSave);
}

async function switchSession(domain, tabId) {
  sessionQueue = sessionQueue.then(async () => {
    try {
      await endCurrentSession();
      if (domain) {
        currentSession = {
          domain,
          tabId,
          startTime: Date.now()
        };
        await chrome.storage.local.set({ currentSession });
      }
    } catch (e) {
      console.error('Error in switchSession queue:', e);
    }
  });
  return sessionQueue;
}

async function handleTabActivation(tab) {
  if (isIdle) return;

  try {
    if (tab && tab.url) {
      const domain = getDomain(tab.url);
      await switchSession(domain, tab.id);
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
      const domain = getDomain(tab.url);
      await switchSession(domain, tabId);
    }
  } catch (e) {
    console.error('Error handling tab update:', e);
  }
}

async function handleWindowFocusChanged(windowId) {
  if (isIdle) return;

  try {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await switchSession(null, null);
      return;
    }

    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs && tabs[0] && tabs[0].url) {
      const domain = getDomain(tabs[0].url);
      await switchSession(domain, tabs[0].id);
    }
  } catch (e) {
    console.error('Error handling window focus change:', e);
  }
}

async function handleTabRemoved(tabId) {
  if (currentSession && currentSession.tabId === tabId) {
    try {
      await switchSession(null, null);
    } catch (e) {
      console.error('Error handling tab removal:', e);
    }
  }
}

async function pruneOldData() {
  try {
    const settings = await getSettings();
    const retentionDays = settings.retentionDays || PRUNE_DAYS;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);

    const allData = await chrome.storage.local.get(null);
    const keysToRemove = [];

    for (const key of Object.keys(allData)) {
      if (!key.startsWith('usage:')) continue;
      const dateStr = key.replace('usage:', '');
      const date = new Date(dateStr + 'T00:00:00');
      if (date < cutoffDate) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove);
    }
  } catch (e) {
    console.error('Error pruning old data:', e);
  }
}

chrome.idle.setDetectionInterval(IDLE_DETECTION_INTERVAL);

async function applySettings() {
  try {
    const settings = await getSettings();
    const interval = Math.max(settings.idleThreshold || IDLE_DETECTION_INTERVAL, IDLE_MIN_INTERVAL);
    chrome.idle.setDetectionInterval(interval);
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
      await switchSession(null, null);
    } else if (newState === 'active') {
      isIdle = false;
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].url) {
        const domain = getDomain(tabs[0].url);
        await switchSession(domain, tabs[0].id);
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

chrome.runtime.onSuspend.addListener(async () => {
  try {
    await switchSession(null, null);
  } catch (e) {
    console.error('Error on suspend:', e);
  }
});

chrome.alarms.get('pruneOldData').then((alarms) => {
  if (!alarms || alarms.length === 0) {
    chrome.alarms.create('pruneOldData', { periodInMinutes: 1440 });
  }
});
chrome.alarms.get('sessionCheckpoint').then((alarms) => {
  if (!alarms || alarms.length === 0) {
    chrome.alarms.create('sessionCheckpoint', {
      periodInMinutes: CHECKPOINT_INTERVAL_MS / 60000
    });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pruneOldData') {
    pruneOldData();
  } else if (alarm.name === 'sessionCheckpoint') {
    checkpointSession();
  }
});

(async () => {
  try {
    const saved = await chrome.storage.local.get('currentSession');
    if (saved.currentSession) {
      const elapsed = Date.now() - saved.currentSession.startTime;
      if (elapsed <= SLEEP_CAP_MS) {
        currentSession = saved.currentSession;
        await endCurrentSession();
      } else {
        await chrome.storage.local.remove('currentSession');
      }
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) {
      const domain = getDomain(tabs[0].url);
      await switchSession(domain, tabs[0].id);
    }
  } catch (e) {
    console.error('Error initializing session:', e);
  }
})();
