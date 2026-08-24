(() => {
  const EVALUATION_API_URL: string | null = "__BUILD_EVALUATION_API_URL__";

  function getEvaluationApiUrl(): string | null {
    return EVALUATION_API_URL;
  }

  function getReadingSupportApiUrl(): string | null {
    if (!EVALUATION_API_URL) return null;
    return EVALUATION_API_URL.replace(
      /\/v1\/evaluations$/u,
      "/v1/reading-support",
    );
  }

  function getEvaluationApiPermissionOrigin(): string | null {
    return EVALUATION_API_URL
      ? `${new URL(EVALUATION_API_URL).origin}/*`
      : null;
  }

  globalThis.CodeReadingTrainerEvaluationConfig = Object.freeze({
    getEvaluationApiPermissionOrigin,
    getEvaluationApiUrl,
    getReadingSupportApiUrl,
  });
})();
