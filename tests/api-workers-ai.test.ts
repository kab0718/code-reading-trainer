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

function validModelEvaluation(evidence = "example") {
  return {
    criteria: CRITERIA.map(({ id }) => ({
      id,
      applicable: true,
      percentageScore: 80,
      feedback: `${evidence}をコードと対応付けて説明できています。`,
      exclusionReason: null,
    })),
    strengths: [`${evidence}を説明できています。`],
    gaps: [],
    modelAnswer: `${evidence}を処理して結果を返します。`,
  };
}

function validSchemaEvaluation(evidence = "example") {
  const evaluation = validModelEvaluation(evidence);
  return {
    ...evaluation,
    criteria: Object.fromEntries(
      evaluation.criteria.map(({ id, ...criterion }) => [id, criterion]),
    ),
  };
}

const input = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
  explanation: "文字列の空白を除去します。",
} satisfies EvaluationInput;
const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

test("Workers AI bindingへ構造化出力を要求しURLを送信しない", async () => {
  let receivedModel;
  let receivedInput;
  let receivedOptions;
  const aiMock = {
    run: async (model, modelInput, options) => {
      receivedModel = model;
      receivedInput = modelInput;
      receivedOptions = options;
      return { response: validSchemaEvaluation() };
    },
  };

  const result = await evaluateWithWorkersAI(input, {
    AI: aiMock,
    AI_MODEL: model,
  });

  assert.equal(receivedModel, model);
  assert.equal(receivedInput.temperature, 0);
  assert.equal(receivedInput.seed, 1);
  assert.equal(receivedInput.max_tokens, 1200);
  assert.equal(receivedInput.response_format.type, "json_schema");
  const criteriaSchema =
    receivedInput.response_format.json_schema.properties.criteria;
  assert.equal(criteriaSchema.type, "object");
  assert.equal(criteriaSchema.additionalProperties, false);
  assert.deepEqual(
    criteriaSchema.required,
    CRITERIA.map(({ id }) => id),
  );
  assert.deepEqual(
    Object.keys(criteriaSchema.properties),
    CRITERIA.map(({ id }) => id),
  );
  assert.equal(
    criteriaSchema.properties.inputs_outputs.properties.percentageScore.type,
    "integer",
  );
  assert.match(receivedInput.messages[0].content, /採点アンカー/);
  for (const { id, label } of CRITERIA) {
    assert.match(
      receivedInput.messages[0].content,
      new RegExp(`${id}.*${label}`),
    );
  }
  assert.equal(
    receivedInput.messages[1].content.includes(input.sourceUrl),
    false,
  );
  assert.equal(receivedOptions.signal instanceof AbortSignal, true);
  assert.deepEqual(receivedOptions.tags, ["code-reading-trainer:evaluation"]);
  assert.deepEqual(result, validModelEvaluation());
});

test("不正なモデル出力をクライアント向けレスポンスへ通さない", async () => {
  let callCount = 0;
  const aiMock = {
    run: async () => {
      callCount += 1;
      return { response: "{}" };
    },
  };

  await assert.rejects(
    evaluateWithWorkersAI(input, {
      AI: aiMock,
      AI_MODEL: model,
    }),
    ModelResponseError,
  );
  assert.equal(callCount, 2);
});

test("軸の順序だけが異なるモデル出力を固定順へ正規化する", async () => {
  const wrongOrder = structuredClone(validModelEvaluation());
  [wrongOrder.criteria[0], wrongOrder.criteria[1]] = [
    wrongOrder.criteria[1],
    wrongOrder.criteria[0],
  ];
  let callCount = 0;
  const aiMock = {
    run: async () => {
      callCount += 1;
      return { response: wrongOrder };
    },
  };

  const result = await evaluateWithWorkersAI(input, {
    AI: aiMock,
    AI_MODEL: model,
  });

  assert.deepEqual(result, validModelEvaluation());
  assert.equal(callCount, 1);
});

test("不正な初回出力を検証指示付きで1回だけ再生成する", async () => {
  const duplicateCriterion = structuredClone(validModelEvaluation());
  duplicateCriterion.criteria[1] = duplicateCriterion.criteria[0];
  const unknownCriterion = structuredClone(validModelEvaluation());
  unknownCriterion.criteria.push({
    ...unknownCriterion.criteria[0],
    id: "unknown_criterion" as unknown as (typeof unknownCriterion.criteria)[number]["id"],
  });
  const ungroundedModelAnswer = structuredClone(validModelEvaluation());
  ungroundedModelAnswer.modelAnswer = "入力を処理して結果を返します。";
  const missingObjectKey = structuredClone(validSchemaEvaluation());
  delete missingObjectKey.criteria.purpose;
  const unknownObjectKey = structuredClone(validSchemaEvaluation());
  unknownObjectKey.criteria.unknown_criterion =
    unknownObjectKey.criteria.purpose;
  const nestedObjectId = structuredClone(validSchemaEvaluation());
  Object.assign(nestedObjectId.criteria.purpose, { id: "purpose" });

  for (const invalidOutput of [
    "not-json",
    duplicateCriterion,
    unknownCriterion,
    missingObjectKey,
    unknownObjectKey,
    nestedObjectId,
    ungroundedModelAnswer,
    validModelEvaluation("someexamplex"),
    validModelEvaluation("一般的な処理"),
  ]) {
    const receivedInputs = [];
    const aiMock = {
      run: async (_model, modelInput) => {
        receivedInputs.push(modelInput);
        return receivedInputs.length === 1
          ? { response: invalidOutput }
          : { response: validModelEvaluation() };
      },
    };

    const result = await evaluateWithWorkersAI(input, {
      AI: aiMock,
      AI_MODEL: model,
    });

    assert.deepEqual(result, validModelEvaluation());
    assert.equal(receivedInputs.length, 2);
    assert.equal(receivedInputs[0].messages.length, 2);
    assert.equal(receivedInputs[1].messages.length, 2);
    assert.match(
      receivedInputs[1].messages[0].content,
      /percentageScoreの5点刻み/,
    );
    assert.deepEqual(
      receivedInputs[1].messages[1],
      receivedInputs[0].messages[1],
    );
  }
});

test("代表的なPythonコードと回答を同一推論設定で送信する", async () => {
  const cases = [
    {
      evidence: "stripとlower",
      code: "def normalize_name(name):\n    return name.strip().lower()",
      explanation: "名前の前後の空白を除去し、小文字にして返します。",
    },
    {
      evidence: "age < 0とValueError",
      code: [
        "def validate_age(age):",
        "    if age < 0:",
        '        raise ValueError("age must be non-negative")',
        "    return age",
      ].join("\n"),
      explanation: "負の年齢を拒否し、それ以外は年齢を返します。",
    },
    {
      evidence: "repository.save",
      code: "def store_user(repository, user):\n    repository.save(user)",
      explanation: "repositoryを使ってuserを保存します。",
    },
  ];

  let referenceSystemPrompt;
  for (const gradingCase of cases) {
    const receivedInputs = [];
    const expected = validModelEvaluation(gradingCase.evidence);
    const caseInput = {
      ...input,
      code: gradingCase.code,
      explanation: gradingCase.explanation,
    };
    const aiMock = {
      run: async (_model, modelInput) => {
        receivedInputs.push(modelInput);
        return { response: expected };
      },
    };
    const environment = {
      AI: aiMock,
      AI_MODEL: model,
    };

    const first = await evaluateWithWorkersAI(caseInput, environment);
    const second = await evaluateWithWorkersAI(caseInput, environment);

    assert.deepEqual(first, expected);
    assert.deepEqual(second, first);
    assert.equal(receivedInputs.length, 2);
    for (const modelInput of receivedInputs) {
      assert.equal(modelInput.temperature, 0);
      assert.equal(modelInput.messages.length, 2);
      assert.deepEqual(JSON.parse(modelInput.messages[1].content), {
        language: "python",
        code: gradingCase.code,
        explanation: gradingCase.explanation,
      });
      referenceSystemPrompt ??= modelInput.messages[0].content;
      assert.equal(modelInput.messages[0].content, referenceSystemPrompt);
    }
  }
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
      AI_MODEL: model,
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
      AI_MODEL: model,
    }),
    ModelQuotaError,
  );
});

test("モデル呼び出しを23秒のtimerで中断してtimeoutへ変換する", async () => {
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
    { AI: aiMock, AI_MODEL: model },
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

  assert.equal(requestedTimeout, 23_000);
  assert.equal(receivedSignal.aborted, false);
  timeoutCallback();
  await assert.rejects(evaluation, ModelTimeoutError);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(timeoutCancelled, true);
});
