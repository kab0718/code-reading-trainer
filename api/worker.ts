import { buildEvaluationResponse, CONTRACT_VERSION } from "./evaluation.ts";
import {
  evaluateWithWorkersAI,
  ModelQuotaError,
  ModelResponseError,
  ModelTimeoutError,
} from "./workers-ai.ts";
import type { EvaluationInput, WorkersAiEnvironment } from "./workers-ai.ts";

const MAX_BODY_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 25_000;
const SOURCE_CHECK_TIMEOUT_MS = 3_000;
const EVALUATION_PATH = "/v1/evaluations";
const REQUEST_FIELDS = [
  "language",
  "sourceUrl",
  "code",
  "explanation",
] as const;
const GITHUB_PYTHON_URL =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/.+\.py(?:[?#].*)?$/;

const ERROR_DEFINITIONS = {
  INVALID_JSON: {
    status: 400,
    message: "JSON形式のリクエストを送信してください。",
    retryable: false,
  },
  VALIDATION_ERROR: {
    status: 400,
    message: "リクエストの入力値を確認してください。",
    retryable: false,
  },
  UNAUTHORIZED: {
    status: 401,
    message: "評価APIを利用できません。",
    retryable: false,
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: "リクエストのサイズを64 KiB以下にしてください。",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message:
      "利用回数の上限に達しました。しばらく待ってから再試行してください。",
    retryable: true,
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "評価処理で問題が発生しました。時間を置いて再試行してください。",
    retryable: true,
  },
  MODEL_ERROR: {
    status: 502,
    message: "採点結果を作成できませんでした。再試行してください。",
    retryable: true,
  },
  EVALUATION_TIMEOUT: {
    status: 504,
    message: "評価処理がタイムアウトしました。再試行してください。",
    retryable: true,
  },
} as const;

type ApiErrorCode = keyof typeof ERROR_DEFINITIONS;

interface ValidationDetail {
  field: string;
  reason: string;
}

interface ApiErrorOptions {
  retryAfterSeconds?: number;
}

interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface WorkerEnvironment extends WorkersAiEnvironment {
  ALLOWED_EXTENSION_IDS?: string;
  ALLOW_MISSING_ORIGIN?: string;
  RATE_LIMITER?: RateLimiter;
}

interface WorkerOptions {
  apiTimeoutMs?: number;
  clearTimeout?: (handle: unknown) => void;
  evaluate?: (
    input: EvaluationInput,
    env: WorkerEnvironment,
    signal: AbortSignal,
  ) => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => Date;
  randomUUID?: () => string;
  setTimeout?: (callback: () => void, milliseconds: number) => unknown;
}

export interface EvaluationWorker {
  fetch(request: Request, env: WorkerEnvironment): Promise<Response>;
}

class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: ValidationDetail[];
  readonly retryAfterSeconds?: number;

  constructor(
    code: ApiErrorCode,
    details: ValidationDetail[] = [],
    options: ApiErrorOptions = {},
  ) {
    super(code);
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function runUntilAborted<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(new ApiError("EVALUATION_TIMEOUT"));

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function createErrorResponse(
  error: ApiError,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  const definition = ERROR_DEFINITIONS[error.code];
  const body: {
    contractVersion: string;
    error: {
      code: ApiErrorCode;
      details: ValidationDetail[];
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    };
    requestId: string;
  } = {
    requestId,
    contractVersion: CONTRACT_VERSION,
    error: {
      code: error.code,
      message: definition.message,
      details: Array.isArray(error.details) ? error.details : [],
      retryable: definition.retryable,
    },
  };

  if (error.code === "RATE_LIMITED") {
    body.error.retryAfterSeconds = error.retryAfterSeconds;
    headers["Retry-After"] = String(error.retryAfterSeconds);
  }

  return jsonResponse(body, definition.status, headers);
}

function getAllowedOrigin(
  request: Request,
  env: WorkerEnvironment,
): string | null {
  const origin = request.headers.get("Origin");
  const allowedIds = (env.ALLOWED_EXTENSION_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!origin && env.ALLOW_MISSING_ORIGIN === "true") {
    return null;
  }

  if (
    !origin ||
    !origin.startsWith("chrome-extension://") ||
    !allowedIds.includes(origin.slice("chrome-extension://".length))
  ) {
    throw new ApiError("UNAUTHORIZED");
  }

  return origin;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function characterLength(value: string): number {
  return [...value].length;
}

function isContractSourceUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    characterLength(value) > 2048 ||
    !GITHUB_PYTHON_URL.test(value) ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /%(?![\da-f]{2})/i.test(value)
  ) {
    return false;
  }

  try {
    return new URL(value).hostname === "github.com";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequestBody(value: unknown): EvaluationInput {
  const details: ValidationDetail[] = [];

  if (!isRecord(value)) {
    throw new ApiError("VALIDATION_ERROR", [
      { field: "$", reason: "JSONオブジェクトを指定してください。" },
    ]);
  }

  const actualFields = Object.keys(value);
  for (const field of REQUEST_FIELDS) {
    if (!(field in value)) {
      details.push({ field, reason: "必須項目です。" });
    }
  }
  for (const field of actualFields) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(field)) {
      details.push({
        field: characterLength(field) <= 100 ? field : "$",
        reason: "未定義の項目です。",
      });
    }
  }

  if ("language" in value && value.language !== "python") {
    details.push({ field: "language", reason: "pythonを指定してください。" });
  }
  if ("sourceUrl" in value) {
    if (!isContractSourceUrl(value.sourceUrl)) {
      details.push({
        field: "sourceUrl",
        reason: "公開GitHub repositoryのPythonファイルURLを指定してください。",
      });
    }
  }
  for (const [field, maximum] of [
    ["code", 30_000],
    ["explanation", 5_000],
  ] as const) {
    if (field in value) {
      if (typeof value[field] !== "string") {
        details.push({ field, reason: "文字列で入力してください。" });
      } else if (value[field].trim().length === 0) {
        details.push({ field, reason: "1文字以上で入力してください。" });
      } else if (characterLength(value[field]) > maximum) {
        details.push({
          field,
          reason: `${maximum}文字以下で入力してください。`,
        });
      }
    }
  }

  if (details.length > 0) {
    throw new ApiError("VALIDATION_ERROR", details.slice(0, 20));
  }

  return value as unknown as EvaluationInput;
}

async function readJsonBody(
  request: Request,
  deadlineSignal: AbortSignal,
): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE");
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new ApiError("INVALID_JSON");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await runUntilAborted(
        reader.read(),
        deadlineSignal,
      );
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch {
    if (deadlineSignal.aborted) {
      await reader.cancel();
      throw new ApiError("EVALUATION_TIMEOUT");
    }
    if (totalBytes > MAX_BODY_BYTES) {
      throw new ApiError("PAYLOAD_TOO_LARGE");
    }
    throw new ApiError("INVALID_JSON");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError("INVALID_JSON");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("INVALID_JSON");
  }
}

async function verifyPublicSource(
  sourceUrl: string,
  fetchImplementation: typeof fetch,
  deadlineSignal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_CHECK_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, deadlineSignal]);

  try {
    let currentUrl = sourceUrl;
    let response: Response | undefined;

    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetchImplementation(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        headers: { Accept: "text/html" },
        signal,
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      const location = response.headers.get("Location");
      if (!location || redirectCount === 3) {
        throw new ApiError("INTERNAL_ERROR");
      }
      const nextUrl = new URL(location, currentUrl).href;
      if (!GITHUB_PYTHON_URL.test(nextUrl)) {
        throw new ApiError("VALIDATION_ERROR", [
          {
            field: "sourceUrl",
            reason: "公開されているGitHubのPythonファイルを指定してください。",
          },
        ]);
      }
      currentUrl = nextUrl;
    }

    if (!response) {
      throw new ApiError("INTERNAL_ERROR");
    }
    if (
      response.status === 401 ||
      response.status === 404 ||
      !GITHUB_PYTHON_URL.test(currentUrl)
    ) {
      throw new ApiError("VALIDATION_ERROR", [
        {
          field: "sourceUrl",
          reason: "公開されているGitHubのPythonファイルを指定してください。",
        },
      ]);
    }
    if (!response.ok) {
      throw new ApiError("INTERNAL_ERROR");
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (deadlineSignal.aborted) {
      throw new ApiError("EVALUATION_TIMEOUT");
    }
    throw new ApiError("INTERNAL_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function enforceRateLimit(
  request: Request,
  origin: string | null,
  env: WorkerEnvironment,
): Promise<void> {
  if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.limit !== "function") {
    throw new ApiError("INTERNAL_ERROR");
  }

  const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `${origin ?? "trusted-client"}:${clientAddress}`;
  const { success } = await env.RATE_LIMITER.limit({ key });

  if (!success) {
    throw new ApiError("RATE_LIMITED", [], { retryAfterSeconds: 60 });
  }
}

function secondsUntilNextUtcDay(now: Date): number {
  const nextReset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );

  return Math.max(1, Math.ceil((nextReset - now.getTime()) / 1000));
}

export function createWorker(options: WorkerOptions = {}): EvaluationWorker {
  const fetchImplementation = options.fetch ?? fetch;
  const evaluate = options.evaluate ?? evaluateWithWorkersAI;
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const apiTimeoutMs = options.apiTimeoutMs ?? API_TIMEOUT_MS;
  const scheduleTimeout =
    options.setTimeout ??
    ((callback: () => void, milliseconds: number): unknown =>
      setTimeout(callback, milliseconds));
  const cancelTimeout =
    options.clearTimeout ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
      const requestId = randomUUID();
      let headers: Record<string, string> = {};
      const deadlineController = new AbortController();
      const deadline = scheduleTimeout(
        () => deadlineController.abort(),
        apiTimeoutMs,
      );

      try {
        return await runUntilAborted(
          (async () => {
            const url = new URL(request.url);
            if (url.pathname !== EVALUATION_PATH) {
              throw new ApiError("VALIDATION_ERROR", [
                {
                  field: "$path",
                  reason: `${EVALUATION_PATH}を指定してください。`,
                },
              ]);
            }

            const origin = getAllowedOrigin(request, env);
            headers = corsHeaders(origin);

            if (request.method === "OPTIONS") {
              return new Response(null, { status: 204, headers });
            }
            if (request.method !== "POST") {
              throw new ApiError("VALIDATION_ERROR", [
                { field: "$method", reason: "POSTを指定してください。" },
              ]);
            }
            if (
              request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
              "application/json"
            ) {
              throw new ApiError("VALIDATION_ERROR", [
                {
                  field: "Content-Type",
                  reason: "application/jsonを指定してください。",
                },
              ]);
            }

            const input = validateRequestBody(
              await readJsonBody(request, deadlineController.signal),
            );
            await enforceRateLimit(request, origin, env);
            await verifyPublicSource(
              input.sourceUrl,
              fetchImplementation,
              deadlineController.signal,
            );

            let modelEvaluation;
            try {
              modelEvaluation = await evaluate(
                input,
                env,
                deadlineController.signal,
              );
            } catch (error) {
              if (error instanceof ModelQuotaError) {
                throw new ApiError("RATE_LIMITED", [], {
                  retryAfterSeconds: secondsUntilNextUtcDay(now()),
                });
              }
              if (error instanceof ModelTimeoutError) {
                throw new ApiError("EVALUATION_TIMEOUT");
              }
              if (error instanceof ModelResponseError) {
                throw new ApiError("MODEL_ERROR");
              }
              throw new ApiError("INTERNAL_ERROR");
            }

            let response;
            try {
              response = buildEvaluationResponse(
                modelEvaluation,
                requestId,
                now(),
              );
            } catch {
              throw new ApiError("MODEL_ERROR");
            }

            return jsonResponse(response, 200, headers);
          })(),
          deadlineController.signal,
        );
      } catch (error) {
        return createErrorResponse(
          error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR"),
          requestId,
          headers,
        );
      } finally {
        cancelTimeout(deadline);
      }
    },
  };
}

export default createWorker();
