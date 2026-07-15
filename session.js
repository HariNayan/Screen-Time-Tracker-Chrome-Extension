import { getDay } from './lib.js';

export const DEBOUNCE_MS = 500;
export const SLEEP_CAP_MS = 30 * 60 * 1000;
export const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// storage must expose promise-based get/set/remove (chrome.storage.local
// satisfies this directly; tests inject a mock). `now` is injectable so
// tests can drive the clock across midnight and sleep gaps.
export function createSessionManager(storage, { now = Date.now } = {}) {
  let currentSession = null;
  let sessionQueue = Promise.resolve();

  function enqueue(fn, label) {
    sessionQueue = sessionQueue.then(fn).catch((e) => {
      console.error(`Error in ${label}:`, e);
    });
    return sessionQueue;
  }

  async function persistSession(session) {
    if (!session || session.duration < DEBOUNCE_MS) return;

    const day = getDay(new Date(session.startTime));
    const key = `usage:${day}`;

    const result = await storage.get(key);
    const dayData = result[key] || {};
    dayData[session.domain] = (dayData[session.domain] || 0) + session.duration;
    await storage.set({ [key]: dayData });
  }

  async function endCurrentSession() {
    if (!currentSession) return;

    const duration = now() - currentSession.startTime;

    if (duration > SLEEP_CAP_MS) {
      currentSession = null;
      await storage.remove('currentSession');
      return;
    }

    const sessionToSave = { ...currentSession, duration };
    currentSession = null;
    await storage.remove('currentSession');
    await persistSession(sessionToSave);
  }

  function switchSession(domain, tabId) {
    return enqueue(async () => {
      await endCurrentSession();
      if (domain) {
        currentSession = { domain, tabId, startTime: now() };
        await storage.set({ currentSession });
      }
    }, 'switchSession');
  }

  function checkpointSession() {
    if (!currentSession) return sessionQueue;

    return enqueue(async () => {
      if (!currentSession) return;

      const ts = now();
      const elapsed = ts - currentSession.startTime;
      if (elapsed < CHECKPOINT_INTERVAL_MS) return;

      const startDay = getDay(new Date(currentSession.startTime));
      const endDay = getDay(new Date(ts));

      if (startDay === endDay) {
        await persistSession({
          domain: currentSession.domain,
          startTime: currentSession.startTime,
          duration: elapsed
        });
      } else {
        const midnight = new Date(ts);
        midnight.setHours(0, 0, 0, 0);
        const firstChunkDuration = midnight.getTime() - currentSession.startTime;
        const secondChunkDuration = ts - midnight.getTime();

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

      currentSession.startTime = ts;
      await storage.set({ currentSession });
    }, 'checkpointSession');
  }

  function restoreSession() {
    return enqueue(async () => {
      const result = await storage.get('currentSession');
      if (result.currentSession) {
        currentSession = result.currentSession;
        await endCurrentSession();
      }
    }, 'restoreSession');
  }

  return {
    get currentSession() { return currentSession; },
    switchSession,
    checkpointSession,
    restoreSession
  };
}
