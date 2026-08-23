(() => {
  const STORAGE_KEY = "anonymousUsageEvents";
  const MAX_EVENTS = 100;
  let pendingWrite = Promise.resolve();

  async function record(
    name:
      | "reading_support_started"
      | "reading_support_guide_displayed"
      | "reading_support_detail_displayed"
      | "reading_support_completed",
    stage?: ReadingSupportStage,
  ): Promise<void> {
    pendingWrite = pendingWrite
      .catch(() => undefined)
      .then(async () => {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const previous = Array.isArray(stored[STORAGE_KEY])
          ? stored[STORAGE_KEY]
          : [];
        const event = {
          name,
          occurredAt: new Date().toISOString(),
          mode: "reading_support",
          ...(stage ? { stage } : {}),
        };
        await chrome.storage.local.set({
          [STORAGE_KEY]: [...previous, event].slice(-MAX_EVENTS),
        });
      });
    return pendingWrite;
  }

  globalThis.CodeReadingTrainerAnalytics = Object.freeze({ record });
})();
