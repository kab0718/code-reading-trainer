import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  allocateMaximumScores,
  buildEvaluationResponse,
  CRITERIA,
  validateModelEvaluation,
} from "../api/evaluation.ts";

const responseSchema = JSON.parse(
  await readFile(
    new URL(
      "../contracts/evaluation/v1/evaluation-response.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateResponseSchema = ajv.compile(responseSchema);

function createModelEvaluation(
  excludedIds = new Set(["branches_errors", "side_effects"]),
) {
  return {
    criteria: CRITERIA.map(({ id }) => {
      if (excludedIds.has(id)) {
        return {
          id,
          applicable: false,
          percentageScore: 0,
          feedback: null,
          exclusionReason: "選択コードに該当する処理がありません。",
        };
      }

      return {
        id,
        applicable: true,
        percentageScore: 80,
        feedback: "コードの処理を概ね説明できています。",
        exclusionReason: null,
      };
    }),
    strengths: ["主要なデータ変換を説明できています。"],
    gaps: ["入力値の前提に触れると、より正確です。"],
    modelAnswer: "入力を正規化して、その結果を返します。",
  };
}

test("最大剰余方式で対象軸の満点を100点へ再配分する", () => {
  const result = allocateMaximumScores(
    new Set([
      "purpose",
      "inputs_outputs",
      "main_flow",
      "assumptions_dependencies",
    ]),
  );

  assert.deepEqual(Object.fromEntries(result), {
    purpose: 34,
    inputs_outputs: 20,
    main_flow: 33,
    assumptions_dependencies: 13,
  });
});

test("対象軸が1つもないモデル出力を拒否する", () => {
  const output = createModelEvaluation(new Set(CRITERIA.map(({ id }) => id)));

  assert.equal(validateModelEvaluation(output), false);
  assert.throws(
    () =>
      buildEvaluationResponse(output, "4fd0d833-6bad-4d6e-b2e2-7fd9ba73710b"),
    /expected schema/,
  );
});

test("採点の揺れを抑える5点刻み以外の割合点を拒否する", () => {
  const output = createModelEvaluation();
  output.criteria[0].percentageScore = 83;

  assert.equal(validateModelEvaluation(output), false);
});

test("軸の固定順、未知フィールド、対象外軸のnull規則を検証する", () => {
  const wrongOrder = structuredClone(createModelEvaluation());
  [wrongOrder.criteria[0], wrongOrder.criteria[1]] = [
    wrongOrder.criteria[1],
    wrongOrder.criteria[0],
  ];

  const unknownField = {
    ...createModelEvaluation(),
    totalScore: 80,
  };

  const inconsistentExcludedCriterion = structuredClone(
    createModelEvaluation(),
  );
  inconsistentExcludedCriterion.criteria[3].feedback =
    "対象外なのにfeedbackがあります。";

  assert.equal(validateModelEvaluation(wrongOrder), false);
  assert.equal(validateModelEvaluation(unknownField), false);
  assert.equal(validateModelEvaluation(inconsistentExcludedCriterion), false);
});

test("モデルの割合点を契約どおりの観点別得点へ正規化する", () => {
  const response = buildEvaluationResponse(
    createModelEvaluation(),
    "4fd0d833-6bad-4d6e-b2e2-7fd9ba73710b",
    new Date("2026-08-16T00:00:00.000Z"),
  );

  assert.equal(validateResponseSchema(response), true, ajv.errorsText());
  assert.deepEqual(
    response.criteria.map(({ id, score, maxScore }) => ({
      id,
      score,
      maxScore,
    })),
    [
      { id: "purpose", score: 27, maxScore: 34 },
      { id: "inputs_outputs", score: 16, maxScore: 20 },
      { id: "main_flow", score: 26, maxScore: 33 },
      { id: "branches_errors", score: null, maxScore: 0 },
      { id: "side_effects", score: null, maxScore: 0 },
      { id: "assumptions_dependencies", score: 10, maxScore: 13 },
    ],
  );
  assert.equal(response.totalScore, 79);
  assert.equal(
    response.criteria.reduce((sum, item) => sum + item.maxScore, 0),
    100,
  );
});
