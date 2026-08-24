import assert from "node:assert/strict";
import test from "node:test";

import type { ReadingSupportInput } from "../api/reading-support.ts";
import { supportReadingWithWorkersAI } from "../api/workers-reading-support.ts";
import { ModelResponseError } from "../api/workers-ai.ts";

const input = {
  language: "python",
  sourceUrl: "https://github.com/example/repo/blob/main/example.py",
  code: "def example(value):\n    return value.strip()",
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
        if (options.tags[0].endsWith(":grounding")) {
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
  assert.deepEqual(receivedOptions.tags, ["crt:reading:guide"]);
});

test("対象コードにない次候補が続く場合は安全なガイドへフォールバックする", async () => {
  let calls = 0;
  const result = await supportReadingWithWorkersAI(input, {
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
  });
  assert.ok("focusPoints" in result);
  assert.deepEqual(result.nextCandidates, []);
  assert.match(result.focusPoints[0], /example/u);
  assert.equal(calls, 2);
});

test("コード識別子に根拠付けられない出力も安全なガイドへフォールバックする", async () => {
  const result = await supportReadingWithWorkersAI(input, {
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
  });
  assert.ok("checks" in result);
  assert.match(result.checks[0], /example/u);
});

test("ガイドの根拠確認が続けて不合格なら安全なガイドへフォールバックする", async () => {
  let generationCalls = 0;
  let verificationCalls = 0;
  const result = await supportReadingWithWorkersAI(input, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding")) {
          verificationCalls += 1;
          return {
            response: {
              grounded: false,
              unsupportedClaims: ["value の取得元に関する断定"],
            },
          };
        }
        generationCalls += 1;
        return { response: guide };
      },
    },
  });
  assert.ok("focusPoints" in result);
  assert.match(result.focusPoints[0], /example/u);
  assert.deepEqual(result.nextCandidates, []);
  assert.equal(generationCalls, 2);
  assert.equal(verificationCalls, 2);
});

test("ガイドのモデル呼び出し自体が失敗しても安全なガイドへフォールバックする", async () => {
  const result = await supportReadingWithWorkersAI(input, {
    AI_MODEL: "test-model",
    AI: {
      async run() {
        throw new Error("model unavailable");
      },
    },
  });
  assert.ok("focusPoints" in result);
  assert.match(result.focusPoints[0], /example/u);
});

test("詳しい説明の範囲外断定をgrounding確認で拒否する", async () => {
  const detailInput = {
    ...input,
    stage: "detailed_explanation",
  } satisfies ReadingSupportInput;
  let generationCalls = 0;
  let verificationCalls = 0;
  await assert.rejects(
    supportReadingWithWorkersAI(detailInput, {
      AI_MODEL: "test-model",
      AI: {
        async run(_model, _modelInput, options) {
          if (options.tags[0].endsWith(":grounding")) {
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
              detailedExplanation:
                "example の value は必ず認証済みデータベース由来です。",
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

test("詳しい説明はgrounding確認後に1回再生成して回復する", async () => {
  const detailInput = {
    ...input,
    stage: "detailed_explanation",
  } satisfies ReadingSupportInput;
  let generationCalls = 0;
  let verificationCalls = 0;
  let retryPrompt = "";
  const result = await supportReadingWithWorkersAI(detailInput, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding")) {
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
                  detailedExplanation:
                    "example の value は必ず外部APIから取得されます。",
                }
              : {
                  detailedExplanation:
                    "example は value.strip() の結果を返します。",
                },
        };
      },
    },
  });
  assert.deepEqual(result, {
    detailedExplanation: "example は value.strip() の結果を返します。",
  });
  assert.equal(generationCalls, 2);
  assert.equal(verificationCalls, 2);
  assert.match(retryPrompt, /前回の出力はSchemaまたは検証規則/u);
});

test("Unicode識別子を根拠として境界付きで照合する", async () => {
  const unicodeInput = {
    ...input,
    code: "def 正規化(値):\n    return 値.strip()",
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
          response: options.tags[0].endsWith(":grounding")
            ? groundedVerification
            : unicodeGuide,
        };
      },
    },
  });
  assert.deepEqual(result, unicodeGuide);
});

test("1文字識別子の部分文字列だけなら安全なガイドへフォールバックする", async () => {
  const shortInput = {
    ...input,
    code: "a = 1",
  };
  const result = await supportReadingWithWorkersAI(shortInput, {
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
  });
  assert.ok("focusPoints" in result);
  assert.match(result.focusPoints[0], /a/u);
});

test("詳しい説明は通常テキストを検証して専用形式へ変換する", async () => {
  const detailInput = {
    ...input,
    stage: "detailed_explanation",
  } satisfies ReadingSupportInput;
  let generationResponseFormat;
  const result = await supportReadingWithWorkersAI(detailInput, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding")) {
          return { response: groundedVerification };
        }
        generationResponseFormat = modelInput.response_format;
        return {
          response:
            "example は value.strip() の結果を返します。型は対象コードからは確認できません。",
        };
      },
    },
  });
  assert.ok("detailedExplanation" in result);
  assert.match(result.detailedExplanation, /対象コードからは確認できません/u);
  assert.equal(generationResponseFormat, undefined);
});

test("根拠確認はproviderのSchema強制に依存せずアプリ側で検証する", async () => {
  const detailInput = {
    ...input,
    stage: "detailed_explanation",
  } satisfies ReadingSupportInput;
  let groundingResponseFormat;
  await supportReadingWithWorkersAI(detailInput, {
    AI_MODEL: "test-model",
    AI: {
      async run(_model, modelInput, options) {
        if (options.tags[0].endsWith(":grounding")) {
          groundingResponseFormat = modelInput.response_format;
          return { response: groundedVerification };
        }
        return {
          response: {
            detailedExplanation: "example は value.strip() の結果を返します。",
          },
        };
      },
    },
  });
  assert.deepEqual(groundingResponseFormat, { type: "json_object" });
});
