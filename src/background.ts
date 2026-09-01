importScripts(
  "evaluation-config.js",
  "evaluation-contract.js",
  "reading-support-contract.js",
);

import { requestTrainingCandidates } from "./python-candidates.js";
import { selectRepositoryReadingRoute } from "./repository-reading-route.js";

(() => {
  const EVALUATION_TIMEOUT_MS = 70_000;
  const GITHUB_TREE_TIMEOUT_MS = 15_000;
  const MAX_TREE_ENTRIES = 20_000;
  const MAX_TREE_RESPONSE_BYTES = 5 * 1024 * 1024;
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

  function repositoryContextKey(value: unknown): string {
    if (!isRecord(value)) return "invalid";
    return JSON.stringify([
      value.repository ?? null,
      value.commitOid ?? null,
      value.ref ?? null,
    ]);
  }

  async function readJsonWithLimit(
    response: Response,
  ): Promise<{ tooLarge: boolean; value?: unknown }> {
    if (!response.body) {
      return { tooLarge: false, value: await response.json() };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TREE_RESPONSE_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      tooLarge: false,
      value: JSON.parse(new TextDecoder().decode(combined)) as unknown,
    };
  }

  async function requestRepositoryReadingRoute(
    context: unknown,
    requestId: string,
    tabId: unknown,
  ): Promise<RepositoryReadingRouteWorkerResult> {
    const contextKey = repositoryContextKey(context);
    const error = (
      code: string,
      message: string,
      retryable = true,
    ): RepositoryReadingRouteWorkerResult => ({
      contextKey,
      error: { code, message, retryable },
      ok: false,
      requestId,
    });
    if (
      !Number.isInteger(tabId) ||
      (tabId as number) < 0 ||
      !isRecord(context) ||
      context.status !== "repository" ||
      typeof context.url !== "string" ||
      typeof context.repository !== "string" ||
      !/^[^/]+\/[^/]+$/u.test(context.repository) ||
      typeof context.ref !== "string" ||
      typeof context.commitOid !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(context.commitOid)
    ) {
      return error(
        "INVALID_CONTEXT",
        "表示中のrepositoryが変わったため、読解順序を作成できませんでした。",
        false,
      );
    }
    try {
      const tab = await chrome.tabs.get(tabId as number);
      if (!tab.url || tab.url !== context.url) {
        return error(
          "INVALID_CONTEXT",
          "表示中のrepositoryが変わりました。",
          false,
        );
      }
      const latest = (await chrome.tabs.sendMessage(tabId as number, {
        type: "GET_PAGE_CONTEXT",
      })) as unknown;
      if (!isRecord(latest) || latest.status !== "repository") {
        return error(
          "INVALID_CONTEXT",
          "表示中のrepositoryが変わりました。",
          false,
        );
      }
      for (const field of ["url", "repository", "ref", "commitOid"] as const) {
        if (latest[field] !== context[field]) {
          return error(
            "INVALID_CONTEXT",
            "表示中のrepositoryが変わりました。",
            false,
          );
        }
      }

      const [owner = "", repositoryName = ""] = context.repository.split("/");
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        GITHUB_TREE_TIMEOUT_MS,
      );
      let response: Response;
      let body: unknown;
      try {
        response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/git/trees/${context.commitOid}?recursive=1`,
          {
            headers: { Accept: "application/vnd.github+json" },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          clearTimeout(timeout);
          const rateLimited =
            response.status === 403 || response.status === 429;
          return error(
            rateLimited ? "GITHUB_RATE_LIMITED" : "GITHUB_API_ERROR",
            rateLimited
              ? "GitHub APIの利用上限に達しました。しばらく待ってから再試行してください。"
              : "GitHubからファイル構成を取得できませんでした。もう一度お試しください。",
          );
        }
        const contentLength = Number(
          response.headers?.get("content-length") ?? Number.NaN,
        );
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_TREE_RESPONSE_BYTES
        ) {
          clearTimeout(timeout);
          return error(
            "TREE_TOO_LARGE",
            "repositoryのファイル構成が大きすぎるため、読解順序を作成できませんでした。",
            false,
          );
        }
        const parsed = await readJsonWithLimit(response);
        if (parsed.tooLarge) {
          clearTimeout(timeout);
          return error(
            "TREE_TOO_LARGE",
            "repositoryのファイル構成が大きすぎるため、読解順序を作成できませんでした。",
            false,
          );
        }
        body = parsed.value;
      } catch {
        clearTimeout(timeout);
        return error(
          controller.signal.aborted ? "GITHUB_TIMEOUT" : "GITHUB_NETWORK_ERROR",
          controller.signal.aborted
            ? "ファイル構成の取得がタイムアウトしました。もう一度お試しください。"
            : "GitHubからファイル構成を取得できませんでした。もう一度お試しください。",
        );
      }
      clearTimeout(timeout);
      if (!isRecord(body) || !Array.isArray(body.tree)) {
        return error(
          "INVALID_GITHUB_RESPONSE",
          "GitHubから不正な応答を受信しました。もう一度お試しください。",
        );
      }
      if (body.tree.length > MAX_TREE_ENTRIES || body.truncated === true) {
        return error(
          "TREE_TOO_LARGE",
          "repositoryのファイル構成が大きすぎるため、読解順序を作成できませんでした。",
          false,
        );
      }
      const entries: Array<{ path: string; type: "blob" | "tree" }> =
        body.tree.flatMap((entry) =>
          isRecord(entry) &&
          typeof entry.path === "string" &&
          (entry.type === "blob" || entry.type === "tree")
            ? [{ path: entry.path, type: entry.type as "blob" | "tree" }]
            : [],
        );
      const candidates = selectRepositoryReadingRoute(
        entries,
        context.repository,
        context.commitOid,
      );
      if (candidates.length === 0) {
        return error(
          "EMPTY_ROUTE",
          "読解を始める候補を見つけられませんでした。",
        );
      }
      return { candidates, contextKey, ok: true, requestId };
    } catch {
      return error(
        "GITHUB_API_ERROR",
        "読解順序を作成できませんでした。もう一度お試しください。",
      );
    }
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
          "読解サポートがタイムアウトしました。対象コードは保持されています。",
          true,
        );
      }
      return receivedResponse
        ? createError(
            "INVALID_API_RESPONSE",
            "読解サポートAPIから不正な応答を受信しました。対象コードは保持されています。",
            true,
          )
        : createError(
            "NETWORK_ERROR",
            "読解サポートAPIに接続できませんでした。対象コードは保持されています。",
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
      "読解サポートAPIから不正な応答を受信しました。対象コードは保持されています。",
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
        message.type === "REQUEST_REPOSITORY_READING_ROUTE" &&
        typeof message.requestId === "string" &&
        message.requestId.length <= 100
      ) {
        void requestRepositoryReadingRoute(
          message.context,
          message.requestId,
          message.tabId,
        ).then(sendResponse);
        return true;
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
