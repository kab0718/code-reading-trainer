import assert from "node:assert/strict";
import test from "node:test";

import { CRITERIA } from "../api/evaluation.ts";
import {
  evaluateWithWorkersAI,
  ModelQuotaError,
  ModelResponseError,
  ModelTimeoutError,
} from "../api/workers-ai.ts";
import type { EvaluationInput } from "../api/workers-ai.ts";

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

const input = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
  explanation: "文字列の空白を除去します。",
} satisfies EvaluationInput;

test("Workers AI bindingへ構造化出力を要求しURLを送信しない", async () => {
  let receivedModel;
  let receivedInput;
  let receivedOptions;
  const aiMock = {
    run: async (model, modelInput, options) => {
      receivedModel = model;
      receivedInput = modelInput;
      receivedOptions = options;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(validModelEvaluation()),
            },
          },
        ],
      };
    },
  };

  const result = await evaluateWithWorkersAI(input, {
    AI: aiMock,
    AI_MODEL: "@cf/openai/gpt-oss-20b",
  });

  assert.equal(receivedModel, "@cf/openai/gpt-oss-20b");
  assert.equal(receivedInput.temperature, 0);
  assert.equal(receivedInput.max_tokens, 4000);
  assert.equal(receivedInput.response_format.type, "json_schema");
  assert.equal(receivedInput.response_format.json_schema.strict, true);
  assert.equal(
    receivedInput.messages[1].content.includes(input.sourceUrl),
    false,
  );
  assert.equal(receivedOptions.signal instanceof AbortSignal, true);
  assert.deepEqual(receivedOptions.tags, ["code-reading-trainer:evaluation"]);
  assert.deepEqual(result, validModelEvaluation());
});

test("不正なモデル出力をクライアント向けレスポンスへ通さない", async () => {
  const aiMock = {
    run: async () => ({ response: "{}" }),
  };

  await assert.rejects(
    evaluateWithWorkersAI(input, {
      AI: aiMock,
      AI_MODEL: "@cf/openai/gpt-oss-20b",
    }),
    ModelResponseError,
  );
});

test("Workers AIの生エラーを汎用モデルエラーへ変換する", async () => {
  const aiMock = {
    run: async () => {
      throw new Error("raw provider details");
    },
  };

  await assert.rejects(
    evaluateWithWorkersAI(input, {
      AI: aiMock,
      AI_MODEL: "@cf/openai/gpt-oss-20b",
    }),
    (error) => {
      assert.equal(error instanceof ModelResponseError, true);
      assert.equal(
        error instanceof Error &&
          error.message.includes("raw provider details"),
        false,
      );
      return true;
    },
  );
});

test("Workers AI無料割当超過を専用エラーへ変換する", async () => {
  const aiMock = {
    run: async () => {
      const error = Object.assign(
        new Error("You have used up your daily free allocation."),
        { code: 3036 },
      );
      throw error;
    },
  };

  await assert.rejects(
    evaluateWithWorkersAI(input, {
      AI: aiMock,
      AI_MODEL: "@cf/openai/gpt-oss-20b",
    }),
    ModelQuotaError,
  );
});

test("モデル呼び出しを20秒のtimerで中断してtimeoutへ変換する", async () => {
  let timeoutCallback;
  let requestedTimeout;
  let timeoutCancelled = false;
  let receivedSignal;
  const aiMock = {
    run: async (_model, _input, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  };
  const evaluation = evaluateWithWorkersAI(
    input,
    { AI: aiMock, AI_MODEL: "@cf/openai/gpt-oss-20b" },
    undefined,
    {
      setTimeout: (callback, timeout) => {
        timeoutCallback = callback;
        requestedTimeout = timeout;
        return "model-timeout";
      },
      clearTimeout: (timer) => {
        assert.equal(timer, "model-timeout");
        timeoutCancelled = true;
      },
    },
  );

  assert.equal(requestedTimeout, 20_000);
  assert.equal(receivedSignal.aborted, false);
  timeoutCallback();
  await assert.rejects(evaluation, ModelTimeoutError);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(timeoutCancelled, true);
});
