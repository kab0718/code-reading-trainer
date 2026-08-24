importScripts(
  "evaluation-config.js",
  "evaluation-contract.js",
  "reading-support-contract.js",
);

import { requestTrainingCandidates } from "./python-candidates.js";

(() => {
  const EVALUATION_TIMEOUT_MS = 70_000;
  const MAX_REQUEST_BYTES = 64 * 1024;
  const inFlightEvaluations = new Map<
    string,
    Promise<EvaluationWorkerResult>
  >();
  const inFlightReadingSupport = new Map<
    string,
    Promise<EvaluationWorkerResult>
  >();

  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function countCharacters(value: string): number {
    return Array.from(value).length;
  }

  function isEvaluationRequest(value: unknown): value is EvaluationRequest {
    return (
      isRecord(value) &&
      Object.keys(value).length === 4 &&
      value.language === "python" &&
      typeof value.sourceUrl === "string" &&
      typeof value.code === "string" &&
      typeof value.explanation === "string"
    );
  }

  function isReadingSupportRequest(
    value: unknown,
  ): value is ReadingSupportRequest {
    return (
      isRecord(value) &&
      Object.keys(value).length === 4 &&
      value.language === "python" &&
      typeof value.sourceUrl === "string" &&
      typeof value.code === "string" &&
      (value.stage === "guide" || value.stage === "detailed_explanation")
    );
  }

  function isValidSourceUrl(value: string): boolean {
    if (countCharacters(value) > 2_048) return false;

    try {
      const url = new URL(value);
      const segments = url.pathname.split("/").filter(Boolean);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        segments.length >= 5 &&
        segments[2] === "blob" &&
        segments.at(-1)?.endsWith(".py") === true
      );
    } catch {
      return false;
    }
  }

  function validateRequest(request: EvaluationRequest): string | null {
    if (
      !isValidSourceUrl(request.sourceUrl) ||
      request.code.trim().length === 0 ||
      request.explanation.trim().length === 0 ||
      countCharacters(request.code) > 30_000 ||
      countCharacters(request.explanation) > 5_000
    ) {
      return "評価するコードと回答を確認してください。";
    }

    if (
      new TextEncoder().encode(JSON.stringify(request)).byteLength >
      MAX_REQUEST_BYTES
    ) {
      return "評価するコードと回答の合計サイズが上限を超えています。";
    }

    return null;
  }

  function validateReadingSupportRequest(
    request: ReadingSupportRequest,
  ): string | null {
    if (
      !isValidSourceUrl(request.sourceUrl) ||
      request.code.trim().length === 0 ||
      countCharacters(request.code) > 30_000
    ) {
      return "読解するコードを確認してください。";
    }
    if (
      new TextEncoder().encode(JSON.stringify(request)).byteLength >
      MAX_REQUEST_BYTES
    ) {
      return "読解するコードのサイズが上限を超えています。";
    }
    return null;
  }

  function createError(
    code: string,
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ): EvaluationWorkerResult {
    return {
      error: {
        code,
        message,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        retryable,
      },
      ok: false,
    };
  }

  function candidateContextKey(value: unknown): string {
    if (!isRecord(value)) return "invalid";
    return JSON.stringify([
      value.repository ?? null,
      value.commitOid ?? null,
      value.path ?? null,
    ]);
  }

  async function requestCandidatesFromCurrentTab(
    context: unknown,
    requestId: string,
    tabId: unknown,
  ): Promise<TrainingCandidatesWorkerResult> {
    const invalid = (): TrainingCandidatesWorkerResult => ({
      contextKey: candidateContextKey(context),
      error: {
        code: "INVALID_CONTEXT",
        message: "表示中のファイルが変わったため、候補を取得できませんでした。",
        retryable: false,
      },
      ok: false,
      requestId,
    });
    if (
      !Number.isInteger(tabId) ||
      (tabId as number) < 0 ||
      !isRecord(context)
    ) {
      return invalid();
    }
    try {
      const tab = await chrome.tabs.get(tabId as number);
      if (!tab.url || tab.url !== context.url) return invalid();
      const latest = (await chrome.tabs.sendMessage(tabId as number, {
        type: "GET_PAGE_CONTEXT",
      })) as unknown;
      if (!isRecord(latest) || latest.status !== "eligible") return invalid();
      for (const field of [
        "url",
        "repository",
        "ref",
        "path",
        "commitOid",
      ] as const) {
        if (latest[field] !== context[field]) return invalid();
      }
      return requestTrainingCandidates(context, requestId);
    } catch {
      return invalid();
    }
  }

  async function evaluateAnswer(
    request: EvaluationRequest,
  ): Promise<EvaluationWorkerResult> {
    const validationMessage = validateRequest(request);
    if (validationMessage) {
      return createError("VALIDATION_ERROR", validationMessage, false);
    }

    const apiUrl =
      globalThis.CodeReadingTrainerEvaluationConfig.getEvaluationApiUrl();
    if (!apiUrl) {
      return createError(
        "API_NOT_CONFIGURED",
        "評価APIの接続先が設定されていません。",
        false,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);

    let response: Response;
    let body: unknown;
    let receivedResponse = false;
    try {
      response = await fetch(apiUrl, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      receivedResponse = true;
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return createError(
          "EVALUATION_TIMEOUT",
          "評価がタイムアウトしました。回答は保持されています。もう一度お試しください。",
          true,
        );
      }
      return receivedResponse
        ? createError(
            "INVALID_API_RESPONSE",
            "評価APIから不正な応答を受信しました。回答は保持されています。",
            true,
          )
        : createError(
            "NETWORK_ERROR",
            "評価APIに接続できませんでした。回答は保持されています。もう一度お試しください。",
            true,
          );
    } finally {
      clearTimeout(timeout);
    }

    const successfulResponse =
      globalThis.CodeReadingTrainerEvaluationContract.parseResponse(body);
    if (response.ok && successfulResponse) {
      return { ok: true, response: successfulResponse };
    }

    const errorResponse =
      globalThis.CodeReadingTrainerEvaluationContract.parseError(body);
    if (!response.ok && errorResponse) {
      return { error: errorResponse, ok: false };
    }

    return createError(
      "INVALID_API_RESPONSE",
      "評価APIから不正な応答を受信しました。回答は保持されています。",
      true,
    );
  }

  async function requestReadingSupport(
    request: ReadingSupportRequest,
  ): Promise<EvaluationWorkerResult> {
    const validationMessage = validateReadingSupportRequest(request);
    if (validationMessage) {
      return createError("VALIDATION_ERROR", validationMessage, false);
    }
    const apiUrl =
      globalThis.CodeReadingTrainerEvaluationConfig.getReadingSupportApiUrl?.();
    if (!apiUrl) {
      return createError(
        "API_NOT_CONFIGURED",
        "読解サポートAPIの接続先が設定されていません。",
        false,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);
    let response: Response;
    let body: unknown;
    let receivedResponse = false;
    try {
      response = await fetch(apiUrl, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      receivedResponse = true;
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        return createError(
          "READING_SUPPORT_TIMEOUT",
          "読解サポートがタイムアウトしました。選択コードは保持されています。",
          true,
        );
      }
      return receivedResponse
        ? createError(
            "INVALID_API_RESPONSE",
            "読解サポートAPIから不正な応答を受信しました。選択コードは保持されています。",
            true,
          )
        : createError(
            "NETWORK_ERROR",
            "読解サポートAPIに接続できませんでした。選択コードは保持されています。",
            true,
          );
    } finally {
      clearTimeout(timeout);
    }

    const successfulResponse =
      globalThis.CodeReadingTrainerReadingSupportContract.parseResponse(body);
    if (response.ok && successfulResponse) {
      return {
        ok: true,
        response: successfulResponse,
      } as EvaluationWorkerResult;
    }
    const errorResponse =
      globalThis.CodeReadingTrainerReadingSupportContract.parseError(body);
    if (!response.ok && errorResponse) {
      return { error: errorResponse, ok: false };
    }
    return createError(
      "INVALID_API_RESPONSE",
      "読解サポートAPIから不正な応答を受信しました。選択コードは保持されています。",
      true,
    );
  }

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL("src/sidepanel.html") ||
        !isRecord(message)
      ) {
        return false;
      }

      if (
        message.type === "REQUEST_TRAINING_CANDIDATES" &&
        typeof message.requestId === "string" &&
        message.requestId.length <= 100
      ) {
        void requestCandidatesFromCurrentTab(
          message.context,
          message.requestId,
          message.tabId,
        ).then(sendResponse);
        return true;
      }

      if (
        message.type === "REQUEST_READING_SUPPORT" &&
        isReadingSupportRequest(message.request)
      ) {
        const requestKey = JSON.stringify(message.request);
        let support = inFlightReadingSupport.get(requestKey);
        if (!support) {
          support = requestReadingSupport(message.request).finally(() => {
            inFlightReadingSupport.delete(requestKey);
          });
          inFlightReadingSupport.set(requestKey, support);
        }
        void support.then(sendResponse);
        return true;
      }

      if (
        message.type !== "EVALUATE_ANSWER" ||
        !isEvaluationRequest(message.request)
      ) {
        return false;
      }

      const requestKey = JSON.stringify(message.request);
      let evaluation = inFlightEvaluations.get(requestKey);
      if (!evaluation) {
        evaluation = evaluateAnswer(message.request).finally(() => {
          inFlightEvaluations.delete(requestKey);
        });
        inFlightEvaluations.set(requestKey, evaluation);
      }
      void evaluation.then(sendResponse);
      return true;
    },
  );
})();
