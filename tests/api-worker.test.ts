import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CRITERIA } from "../api/evaluation.ts";
import {
  ModelQuotaError,
  ModelResponseError,
  ModelTimeoutError,
} from "../api/workers-ai.ts";
import { createWorker } from "../api/worker.ts";
import type { WorkerEnvironment } from "../api/worker.ts";

const [requestSchema, responseSchema, errorSchema] = await Promise.all(
  [
    "evaluation-request.schema.json",
    "evaluation-response.schema.json",
    "evaluation-error.schema.json",
  ].map(async (filename) =>
    JSON.parse(
      await readFile(
        new URL(`../contracts/evaluation/v1/${filename}`, import.meta.url),
        "utf8",
      ),
    ),
  ),
);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateRequestSchema = ajv.compile(requestSchema);
const validateResponseSchema = ajv.compile(responseSchema);
const validateErrorSchema = ajv.compile(errorSchema);

const requestId = "4fd0d833-6bad-4d6e-b2e2-7fd9ba73710b";
const origin = "chrome-extension://abcdefghijklmnop";
const validInput = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
  explanation: "文字列の空白を除去して返します。",
};

function validModelEvaluation() {
  return {
    criteria: CRITERIA.map(({ id }) => ({
      id,
      applicable: true,
      percentageScore: 80,
      feedback: "説明できています。",
      exclusionReason: null,
    })),
    strengths: ["主要処理を説明できています。"],
    gaps: [],
    modelAnswer: "入力を処理して結果を返します。",
  };
}

function createEnvironment(rateLimitSuccess = true): WorkerEnvironment {
  return {
    ALLOWED_EXTENSION_IDS: "abcdefghijklmnop",
    RATE_LIMITER: {
      limit: async () => ({ success: rateLimitSuccess }),
    },
  };
}

function createRequest(body = JSON.stringify(validInput), headers = {}) {
  return new Request("https://evaluation.example/v1/evaluations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "192.0.2.10",
      ...headers,
    },
    body,
  });
}

function createTestWorker(overrides = {}) {
  return createWorker({
    randomUUID: () => requestId,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    fetch: async () => new Response(null, { status: 200 }),
    evaluate: async () => validModelEvaluation(),
    ...overrides,
  });
}

async function expectContractError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(validateErrorSchema(body), true, ajv.errorsText());
  assert.equal(body.error.code, code);
  assert.equal(JSON.stringify(body).includes(validInput.code), false);
  return body;
}

test("有効なリクエストへv1契約に適合する採点結果を返す", async () => {
  let rateLimitKey;
  const env = createEnvironment();
  env.RATE_LIMITER.limit = async ({ key }) => {
    rateLimitKey = key;
    return { success: true };
  };

  const response = await createTestWorker().fetch(createRequest(), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(rateLimitKey, `${origin}:192.0.2.10`);
  const body = await response.json();
  assert.equal(validateResponseSchema(body), true, ajv.errorsText());
  assert.equal(body.criteria.length, 6);
  assert.equal(
    body.criteria.reduce((sum, item) => sum + item.maxScore, 0),
    100,
  );
  assert.equal(
    body.totalScore,
    body.criteria.reduce((sum, item) => sum + (item.score ?? 0), 0),
  );
});

test("本番Secretの拡張機能IDを通常の環境変数より優先する", async () => {
  const env = createEnvironment();
  env.ALLOWED_EXTENSION_IDS = "not-allowed";
  env.ALLOWED_EXTENSION_IDS_SECRET = "abcdefghijklmnop";

  const response = await createTestWorker().fetch(createRequest(), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("許可されていない拡張機能Originを401で拒否する", async () => {
  const request = createRequest(JSON.stringify(validInput), {
    Origin: "chrome-extension://not-allowed",
  });
  const response = await createTestWorker().fetch(request, createEnvironment());

  await expectContractError(response, 401, "UNAUTHORIZED");
});

test("Originがない本番リクエストを401で拒否する", async () => {
  const request = new Request("https://evaluation.example/v1/evaluations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: "{",
  });
  const response = await createTestWorker().fetch(request, createEnvironment());

  await expectContractError(response, 401, "UNAUTHORIZED");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("壊れたJSONを400で拒否する", async () => {
  const response = await createTestWorker().fetch(
    createRequest("{"),
    createEnvironment(),
  );

  await expectContractError(response, 400, "INVALID_JSON");
});

test("64 KiBを超えるbodyを413で拒否する", async () => {
  const response = await createTestWorker().fetch(
    createRequest(`{"padding":"${"a".repeat(66_000)}"}`),
    createEnvironment(),
  );

  await expectContractError(response, 413, "PAYLOAD_TOO_LARGE");
});

test("未知フィールド、空白回答、非Python言語を400でまとめて拒否する", async () => {
  const response = await createTestWorker().fetch(
    createRequest(
      JSON.stringify({
        ...validInput,
        language: "javascript",
        explanation: "  ",
        unexpected: true,
      }),
    ),
    createEnvironment(),
  );

  const body = await expectContractError(response, 400, "VALIDATION_ERROR");
  assert.deepEqual(body.error.details.map(({ field }) => field).sort(), [
    "explanation",
    "language",
    "unexpected",
  ]);
});

test("v1リクエストSchemaと同じ不正URIを入力検証で拒否する", async () => {
  const input = {
    ...validInput,
    sourceUrl: "https://github.com/example/repo/blob/main/bad%.py",
  };
  assert.equal(validateRequestSchema(input), false);

  const response = await createTestWorker().fetch(
    createRequest(JSON.stringify(input)),
    createEnvironment(),
  );
  const body = await expectContractError(response, 400, "VALIDATION_ERROR");
  assert.equal(body.error.details[0].field, "sourceUrl");
});

test("非公開または存在しないGitHubファイルを400で拒否する", async () => {
  const worker = createTestWorker({
    fetch: async () => new Response(null, { status: 404 }),
  });
  const response = await worker.fetch(createRequest(), createEnvironment());

  const body = await expectContractError(response, 400, "VALIDATION_ERROR");
  assert.equal(body.error.details[0].field, "sourceUrl");
});

test("利用回数制限超過をRetry-After付き429へ変換する", async () => {
  const response = await createTestWorker().fetch(
    createRequest(),
    createEnvironment(false),
  );

  const body = await expectContractError(response, 429, "RATE_LIMITED");
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(body.error.retryAfterSeconds, 60);
});

test("モデルのタイムアウトを504へ変換する", async () => {
  const worker = createTestWorker({
    evaluate: async () => {
      throw new ModelTimeoutError();
    },
  });
  const response = await worker.fetch(createRequest(), createEnvironment());

  await expectContractError(response, 504, "EVALUATION_TIMEOUT");
});

test("Workers AI無料割当超過をUTC日次リセットまでの429へ変換する", async () => {
  const worker = createTestWorker({
    evaluate: async () => {
      throw new ModelQuotaError();
    },
  });
  const response = await worker.fetch(createRequest(), createEnvironment());

  const body = await expectContractError(response, 429, "RATE_LIMITED");
  assert.equal(response.headers.get("Retry-After"), "86400");
  assert.equal(body.error.retryAfterSeconds, 86400);
});

test("body読取や外部処理を含むAPI全体の期限超過を504へ変換する", async () => {
  let deadlineCallback;
  let notifyEvaluationStarted;
  let receivedDeadlineSignal;
  const evaluationStarted = new Promise((resolve) => {
    notifyEvaluationStarted = resolve;
  });
  const worker = createTestWorker({
    evaluate: async (_input, _env, deadlineSignal) => {
      receivedDeadlineSignal = deadlineSignal;
      notifyEvaluationStarted();
      return new Promise(() => {});
    },
    setTimeout: (callback, timeout) => {
      assert.equal(timeout, 31_000);
      deadlineCallback = callback;
      return "api-timeout";
    },
    clearTimeout: (timer) => assert.equal(timer, "api-timeout"),
  });
  const responsePromise = worker.fetch(createRequest(), createEnvironment());

  await evaluationStarted;
  assert.equal(receivedDeadlineSignal.aborted, false);
  deadlineCallback();
  assert.equal(receivedDeadlineSignal.aborted, true);
  const response = await responsePromise;

  await expectContractError(response, 504, "EVALUATION_TIMEOUT");
});

test("長すぎる未知フィールド名でも契約に適合する4xxを返す", async () => {
  const response = await createTestWorker().fetch(
    createRequest(
      JSON.stringify({ ...validInput, ["x".repeat(101)]: "unexpected" }),
    ),
    createEnvironment(),
  );

  const body = await expectContractError(response, 400, "VALIDATION_ERROR");
  assert.equal(body.error.details[0].field, "$");
});

test("モデル障害と不正出力を502へ変換する", async (context) => {
  await context.test("モデルサービス障害", async () => {
    const worker = createTestWorker({
      evaluate: async () => {
        throw new ModelResponseError();
      },
    });
    const response = await worker.fetch(createRequest(), createEnvironment());
    await expectContractError(response, 502, "MODEL_ERROR");
  });

  await context.test("モデル出力不正", async () => {
    const worker = createTestWorker({ evaluate: async () => ({}) });
    const response = await worker.fetch(createRequest(), createEnvironment());
    await expectContractError(response, 502, "MODEL_ERROR");
  });
});
