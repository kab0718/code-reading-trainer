import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createWorker } from "../api/worker.ts";
import type { WorkerEnvironment } from "../api/worker.ts";
import { ModelResponseError, ModelTimeoutError } from "../api/workers-ai.ts";

const schemas = await Promise.all(
  [
    "reading-support-request.schema.json",
    "reading-support-response.schema.json",
    "reading-support-error.schema.json",
  ].map(async (name) =>
    JSON.parse(
      await readFile(
        new URL(`../contracts/reading-support/v1/${name}`, import.meta.url),
        "utf8",
      ),
    ),
  ),
);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const [validateRequest, validateResponse, validateError] = schemas.map(
  (schema) => ajv.compile(schema),
);

const origin = "chrome-extension://abcdefghijklmnop";
const input = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
  question: "value の流れを理解したい",
  stage: "guide",
};
const guide = {
  focusPoints: ["example と value の流れに注目します。"],
  checks: ["value の型は選択範囲からは確認できません。"],
  questions: ["value.strip() の結果はどこへ渡りますか？"],
  hints: ["return value.strip() を内側から追います。"],
  nextCandidates: [
    { symbol: "strip", reason: "strip の定義を確認するためです。" },
  ],
};

function env(): WorkerEnvironment {
  return {
    ALLOWED_EXTENSION_IDS: "abcdefghijklmnop",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

function request(body: unknown = input) {
  return new Request("https://evaluation.example/v1/reading-support", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify(body),
  });
}

function worker(overrides = {}) {
  return createWorker({
    randomUUID: () => "57d8d07a-2596-4f11-851d-ace9b27b25d1",
    now: () => new Date("2026-08-24T00:00:00Z"),
    fetch: async () => new Response(null, { status: 200 }),
    supportReading: async () => guide,
    ...overrides,
  });
}

test("専用エンドポイントでガイド契約を返す", async () => {
  assert.equal(
    validateRequest(input),
    true,
    ajv.errorsText(validateRequest.errors),
  );
  const response = await worker().fetch(request(), env());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(
    validateResponse(body),
    true,
    ajv.errorsText(validateResponse.errors),
  );
  assert.equal(body.stage, "guide");
  assert.equal(body.detailedExplanation, null);
});

test("質問の空入力・上限・未知フィールドを外部処理前に拒否する", async () => {
  let called = false;
  const response = await worker({
    supportReading: async () => {
      called = true;
      return guide;
    },
  }).fetch(request({ ...input, question: " ", unknown: true }), env());
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(validateError(body), true, ajv.errorsText(validateError.errors));
  assert.deepEqual(body.error.details.map(({ field }) => field).sort(), [
    "question",
    "unknown",
  ]);
  assert.equal(called, false);

  const overLimitResponse = await worker().fetch(
    request({ ...input, question: "あ".repeat(2_001) }),
    env(),
  );
  assert.equal(overLimitResponse.status, 400);
  const overLimitBody = await overLimitResponse.json();
  assert.equal(overLimitBody.error.details[0].field, "question");

  const atLimitResponse = await worker().fetch(
    request({ ...input, question: "あ".repeat(2_000) }),
    env(),
  );
  assert.equal(atLimitResponse.status, 200);
});

test("詳しい説明は明示された段階のレスポンスとして返す", async () => {
  const response = await worker({
    supportReading: async () => ({
      detailedExplanation:
        "example は value.strip() の結果を返します。型は選択範囲からは確認できません。",
    }),
  }).fetch(request({ ...input, stage: "detailed_explanation" }), env());
  const body = await response.json();
  assert.equal(
    validateResponse(body),
    true,
    ajv.errorsText(validateResponse.errors),
  );
  assert.equal(body.stage, "detailed_explanation");
  assert.deepEqual(body.hints, []);
  assert.match(body.detailedExplanation, /選択範囲からは確認できません/u);
});

test("読解サポートのモデル障害とタイムアウトを専用コードへ変換する", async (context) => {
  for (const [error, status, code] of [
    [new ModelResponseError(), 502, "READING_SUPPORT_MODEL_ERROR"],
    [new ModelTimeoutError(), 504, "READING_SUPPORT_TIMEOUT"],
  ] as const) {
    await context.test(code, async () => {
      const response = await worker({
        supportReading: async () => {
          throw error;
        },
      }).fetch(request(), env());
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(
        validateError(body),
        true,
        ajv.errorsText(validateError.errors),
      );
      assert.equal(body.error.code, code);
      assert.equal(JSON.stringify(body).includes(input.question), false);
    });
  }
});
