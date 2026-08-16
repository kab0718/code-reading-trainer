import assert from "node:assert/strict";
import test from "node:test";

import { CRITERIA } from "../api/evaluation.mjs";
import {
  evaluateWithOpenAI,
  ModelResponseError,
  ModelTimeoutError,
} from "../api/openai.mjs";

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
};

test("OpenAIの認証情報をサーバー側で付与し、保存せず構造化出力を要求する", async () => {
  let receivedUrl;
  let receivedOptions;
  const fetchMock = async (url, options) => {
    receivedUrl = url;
    receivedOptions = options;
    return Response.json({
      status: "completed",
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify(validModelEvaluation()),
            },
          ],
        },
      ],
    });
  };

  const result = await evaluateWithOpenAI(
    input,
    { OPENAI_API_KEY: "server-secret", OPENAI_MODEL: "test-model" },
    fetchMock,
  );

  assert.equal(receivedUrl, "https://api.openai.com/v1/responses");
  assert.equal(receivedOptions.headers.Authorization, "Bearer server-secret");
  const requestBody = JSON.parse(receivedOptions.body);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.equal(requestBody.input[1].content.includes(input.sourceUrl), false);
  assert.deepEqual(result, validModelEvaluation());
});

test("不正なモデル出力をクライアント向けレスポンスへ通さない", async () => {
  const fetchMock = async () =>
    Response.json({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: "{}" }] }],
    });

  await assert.rejects(
    evaluateWithOpenAI(
      input,
      { OPENAI_API_KEY: "server-secret", OPENAI_MODEL: "test-model" },
      fetchMock,
    ),
    ModelResponseError,
  );
});

test("モデルサービスの生エラー本文を読み込まず汎用エラーへ変換する", async () => {
  let bodyRead = false;
  const fetchMock = async () => ({
    ok: false,
    json: async () => {
      bodyRead = true;
      return { secret: "raw model error" };
    },
  });

  await assert.rejects(
    evaluateWithOpenAI(
      input,
      { OPENAI_API_KEY: "server-secret", OPENAI_MODEL: "test-model" },
      fetchMock,
    ),
    ModelResponseError,
  );
  assert.equal(bodyRead, false);
});

test("モデル呼び出しを20秒のtimerで中断してtimeoutへ変換する", async () => {
  let timeoutCallback;
  let requestedTimeout;
  let timeoutCancelled = false;
  const fetchMock = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  const evaluation = evaluateWithOpenAI(
    input,
    { OPENAI_API_KEY: "server-secret", OPENAI_MODEL: "test-model" },
    fetchMock,
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
  timeoutCallback();
  await assert.rejects(evaluation, ModelTimeoutError);
  assert.equal(timeoutCancelled, true);
});
