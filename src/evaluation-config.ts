(() => {
  // デプロイ先が決まったら、完全な評価API URLをここへ設定する。
  // 未設定の配布物は外部送信を行わず、明示的な設定エラーを返す。
  const EVALUATION_API_URL: string | null = null;

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
