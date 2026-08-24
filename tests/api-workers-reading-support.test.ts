import assert from "node:assert/strict";
import test from "node:test";

import type { ReadingSupportInput } from "../api/reading-support.ts";
import { supportReadingWithWorkersAI } from "../api/workers-reading-support.ts";
import { ModelResponseError } from "../api/workers-ai.ts";

const input = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
  question: "value の処理を理解したい",
  stage: "guide",
} satisfies ReadingSupportInput;

const guide = {
  focusPoints: ["example と value の流れに注目します。"],
  checks: ["value が文字列か候補コードからは確認できません。"],
  questions: ["value.strip() の戻り値はどこへ渡りますか？"],
  hints: ["return value.strip() を内側から追います。"],
  nextCandidates: [
    { symbol: "strip", reason: "strip の定義を確認するためです。" },
  ],
};
const groundedVerification = { grounded: true, unsupportedClaims: [] };

test("ガイド生成ではURLをAIへ送らず専用Schemaとタグを使う", async () => {
  let receivedInput;
  let receivedOptions;
  const result = await supportReadingWithWorkersAI(input, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding-check")) {
          return { response: groundedVerification };
        }
        receivedInput = modelInput;
        receivedOptions = options;
        return { response: guide };
      },
    },
  });
  assert.deepEqual(result, guide);
  assert.equal(receivedInput.temperature, 0);
  assert.equal(receivedInput.response_format.type, "json_schema");
  assert.equal(
    receivedInput.messages[1].content.includes(input.sourceUrl),
    false,
  );
  assert.deepEqual(receivedOptions.tags, [
    "code-reading-trainer:reading-support:guide",
  ]);
});

test("対象コードにない次候補を含む出力は1回再生成しても拒否する", async () => {
  let calls = 0;
  await assert.rejects(
    supportReadingWithWorkersAI(input, {
      AI_MODEL: "test-model",
      AI: {
        async run() {
          calls += 1;
          return {
            response: {
              ...guide,
              nextCandidates: [
                { symbol: "missing_symbol", reason: "推測した候補です。" },
              ],
            },
          };
        },
      },
    }),
    ModelResponseError,
  );
  assert.equal(calls, 2);
});

test("コード識別子に根拠付けられていない確認事項も拒否する", async () => {
  await assert.rejects(
    supportReadingWithWorkersAI(input, {
      AI_MODEL: "test-model",
      AI: {
        async run() {
          return {
            response: {
              ...guide,
              checks: ["データベースへ保存されることを確認します。"],
            },
          };
        },
      },
    }),
    ModelResponseError,
  );
});

test("範囲外の断定をgrounding確認で拒否して再生成する", async () => {
  let generationCalls = 0;
  let verificationCalls = 0;
  await assert.rejects(
    supportReadingWithWorkersAI(input, {
      AI_MODEL: "test-model",
      AI: {
        async run(_model, _modelInput, options) {
          if (options.tags[0].endsWith(":grounding-check")) {
            verificationCalls += 1;
            return {
              response: {
                grounded: false,
                unsupportedClaims: [
                  "value が認証済みデータベース由来という断定",
                ],
              },
            };
          }
          generationCalls += 1;
          return {
            response: {
              ...guide,
              checks: ["value は必ず認証済みデータベース由来です。"],
            },
          };
        },
      },
    }),
    ModelResponseError,
  );
  assert.equal(generationCalls, 2);
  assert.equal(verificationCalls, 2);
});

test("grounding確認で拒否された初回出力を1回再生成して回復する", async () => {
  let generationCalls = 0;
  let verificationCalls = 0;
  let retryPrompt = "";
  const result = await supportReadingWithWorkersAI(input, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding-check")) {
          verificationCalls += 1;
          return {
            response:
              verificationCalls === 1
                ? {
                    grounded: false,
                    unsupportedClaims: ["value の取得元に関する断定"],
                  }
                : groundedVerification,
          };
        }
        generationCalls += 1;
        if (generationCalls === 2) {
          retryPrompt = modelInput.messages[0].content;
        }
        return {
          response:
            generationCalls === 1
              ? {
                  ...guide,
                  checks: ["value は必ず外部APIから取得されます。"],
                }
              : guide,
        };
      },
    },
  });
  assert.deepEqual(result, guide);
  assert.equal(generationCalls, 2);
  assert.equal(verificationCalls, 2);
  assert.match(retryPrompt, /前回の出力はSchemaまたは検証規則/u);
});

test("Unicode識別子を根拠として境界付きで照合する", async () => {
  const unicodeInput = {
    ...input,
    code: "def 正規化(値):\n    return 値.strip()",
    question: "値 の流れを知りたい",
  };
  const unicodeGuide = {
    focusPoints: ["正規化 と 値 の流れに注目します。"],
    checks: ["値 の型は候補コードからは確認できません。"],
    questions: ["値.strip() はどこへ渡りますか？"],
    hints: ["値.strip() を内側から追います。"],
    nextCandidates: [{ symbol: "strip", reason: "strip の定義を確認します。" }],
  };
  const result = await supportReadingWithWorkersAI(unicodeInput, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, _modelInput, options) {
        return {
          response: options.tags[0].endsWith(":grounding-check")
            ? groundedVerification
            : unicodeGuide,
        };
      },
    },
  });
  assert.deepEqual(result, unicodeGuide);
});

test("1文字識別子の部分文字列だけでは根拠として扱わない", async () => {
  const shortInput = {
    ...input,
    code: "a = 1",
    question: "a を確認したい",
  };
  await assert.rejects(
    supportReadingWithWorkersAI(shortInput, {
      AI_MODEL: "test-model",
      AI: {
        async run() {
          return {
            response: {
              focusPoints: ["database を確認します。"],
              checks: ["database を確認します。"],
              questions: ["database とは何ですか？"],
              hints: ["database を追います。"],
              nextCandidates: [],
            },
          };
        },
      },
    }),
    ModelResponseError,
  );
});

test("詳しい説明は明示された段階でだけ専用形式を要求する", async () => {
  const detailInput = {
    ...input,
    stage: "detailed_explanation",
  } satisfies ReadingSupportInput;
  const result = await supportReadingWithWorkersAI(detailInput, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, _modelInput, options) {
        if (options.tags[0].endsWith(":grounding-check")) {
          return { response: groundedVerification };
        }
        return {
          response: {
            detailedExplanation:
              "example は value.strip() の結果を返します。型は候補コードからは確認できません。",
          },
        };
      },
    },
  });
  assert.ok("detailedExplanation" in result);
  assert.match(result.detailedExplanation, /候補コードからは確認できません/u);
});
