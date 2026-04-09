// Shared storage helpers live here so popup, background, and API code stay in sync.

export async function migrateApiKeyToLocal() {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(['openaiApiKey']),
    chrome.storage.sync.get(['openaiApiKey'])
  ]);

  const localKey = (local.openaiApiKey || '').trim();
  const syncKey = (sync.openaiApiKey || '').trim();

  if (localKey) {
    if (syncKey) await chrome.storage.sync.remove(['openaiApiKey']);
    return localKey;
  }

  if (syncKey) {
    await chrome.storage.local.set({ openaiApiKey: syncKey });
    await chrome.storage.sync.remove(['openaiApiKey']);
    return syncKey;
  }

  return '';
}

// Quick way to get the key without caring about the sync->local migration.
export async function getApiKey() {
  const local = await chrome.storage.local.get(['openaiApiKey']);
  const key = (local.openaiApiKey || '').trim();
  if (key) {
    const sync = await chrome.storage.sync.get(['openaiApiKey']);
    if ((sync.openaiApiKey || '').trim()) {
      await chrome.storage.sync.remove(['openaiApiKey']);
    }
    return key;
  }
  return migrateApiKeyToLocal();
}
