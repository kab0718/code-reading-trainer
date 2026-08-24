import assert from "node:assert/strict";

import { CRITERIA } from "../api/evaluation.ts";
import type { EvaluationResponse } from "../api/evaluation.ts";

const MAX_SCORE_SPREAD = 15;

const evaluationCases = [
  {
    name: "文字列の正規化",
    code: "def normalize_name(name):\n    return name.strip().lower()",
    answers: [
      "nameの前後の空白をstripで除去し、lowerで小文字にして返します。",
      "nameにstripを適用して前後の空白を取り、続けてlowerを適用して小文字の文字列を返します。",
    ],
    incompleteAnswer: "nameをlowerで小文字にして返します。",
    evidence: ["name", "strip", "lower"],
    expectedCriteria: ["purpose", "inputs_outputs", "main_flow"],
  },
  {
    name: "分岐と例外",
    code: [
      "def validate_age(age):",
      "    if age < 0:",
      '        raise ValueError("age must be non-negative")',
      "    return age",
    ].join("\n"),
    answers: [
      "ageは0と比較できることを前提に、0未満ならValueErrorを送出し、それ以外はageを返します。",
      "0と比較可能なageを受け取り、負の値をValueErrorで拒否して、非負ならageをそのまま返します。",
    ],
    evidence: ["age", "ValueError", "0"],
    expectedCriteria: [
      "purpose",
      "inputs_outputs",
      "main_flow",
      "branches_errors",
      "assumptions_dependencies",
    ],
  },
  {
    name: "外部への保存",
    code: "def store_user(repository, user):\n    repository.save(user)",
    answers: [
      "repositoryがsaveを提供する前提でuserを渡し、外部状態へ保存します。明示的な戻り値はありません。",
      "saveを持つrepositoryとuserを受け取り、repository.save(user)で外部状態を変更し、値は明示的に返しません。",
    ],
    evidence: ["repository", "save", "user"],
    expectedCriteria: [
      "purpose",
      "inputs_outputs",
      "main_flow",
      "side_effects",
      "assumptions_dependencies",
    ],
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertEvaluationResponse(
  value: unknown,
): asserts value is EvaluationResponse {
  assert.equal(
    isRecord(value),
    true,
    "レスポンスがJSON objectではありません。",
  );
  if (!isRecord(value)) {
    return;
  }

  assert.equal(value.contractVersion, "1.0");
  assert.equal(Number.isInteger(value.totalScore), true);
  assert.equal(Array.isArray(value.criteria), true);
  if (!Array.isArray(value.criteria)) {
    return;
  }

  assert.equal(value.criteria.length, CRITERIA.length);
  let maximumTotal = 0;
  let scoreTotal = 0;
  for (const [index, criterion] of value.criteria.entries()) {
    assert.equal(isRecord(criterion), true);
    if (!isRecord(criterion)) {
      continue;
    }

    assert.equal(criterion.id, CRITERIA[index]?.id);
    assert.equal(Number.isInteger(criterion.maxScore), true);
    maximumTotal += Number(criterion.maxScore);
    if (criterion.applicable === true) {
      assert.equal(Number.isInteger(criterion.score), true);
      assert.equal(Number(criterion.score) >= 0, true);
      assert.equal(Number(criterion.score) <= Number(criterion.maxScore), true);
      scoreTotal += Number(criterion.score);
    } else {
      assert.equal(criterion.score, null);
      assert.equal(criterion.maxScore, 0);
    }
  }

  assert.equal(maximumTotal, 100);
  assert.equal(value.totalScore, scoreTotal);
}

async function requestEvaluation(
  endpoint: string,
  origin: string,
  sourceUrl: string,
  code: string,
  explanation: string,
): Promise<EvaluationResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(70_000),
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      language: "python",
      sourceUrl,
      code,
      explanation,
    }),
  });
  const body: unknown = await response.json();
  assert.equal(
    response.status,
    200,
    `評価APIがHTTP ${response.status}を返しました。`,
  );
  assertEvaluationResponse(body);
  return body;
}

async function main(): Promise<void> {
  const endpoint = process.env.EVALUATION_API_URL;
  const origin = process.env.EVALUATION_TEST_ORIGIN;
  const sourceUrl = process.env.EVALUATION_TEST_SOURCE_URL;
  assert.ok(endpoint, "EVALUATION_API_URLを指定してください。");
  assert.ok(origin, "EVALUATION_TEST_ORIGINを指定してください。");
  assert.ok(sourceUrl, "EVALUATION_TEST_SOURCE_URLを指定してください。");

  for (const evaluationCase of evaluationCases) {
    const explanations = [
      evaluationCase.answers[0],
      evaluationCase.answers[1],
      evaluationCase.answers[0],
    ];
    const results: EvaluationResponse[] = [];
    for (const explanation of explanations) {
      const result = await requestEvaluation(
        endpoint,
        origin,
        sourceUrl,
        evaluationCase.code,
        explanation,
      );
      assert.deepEqual(
        result.criteria
          .filter(({ applicable }) => applicable)
          .map(({ id }) => id),
        evaluationCase.expectedCriteria,
        `${evaluationCase.name}の適用軸が期待と異なります。`,
      );
      results.push(result);
    }

    const scores = results.map(({ totalScore }) => totalScore);
    const spread = Math.max(...scores) - Math.min(...scores);
    assert.equal(
      spread <= MAX_SCORE_SPREAD,
      true,
      `${evaluationCase.name}の総合点差が${spread}点でした。`,
    );

    const applicableCriteria = results.map(({ criteria }) =>
      criteria.filter(({ applicable }) => applicable).map(({ id }) => id),
    );
    for (const applicable of applicableCriteria.slice(1)) {
      assert.deepEqual(
        applicable,
        applicableCriteria[0],
        `${evaluationCase.name}の適用軸が回答間で変わりました。`,
      );
    }

    for (const result of results) {
      for (const criterion of result.criteria.filter(
        ({ applicable }) => applicable,
      )) {
        assert.equal(
          evaluationCase.evidence.some((token) =>
            criterion.feedback?.includes(token),
          ),
          true,
          `${evaluationCase.name}の${criterion.id}フィードバックにコードと回答の具体的根拠がありません。`,
        );
      }
      assert.equal(
        evaluationCase.evidence.some((token) =>
          result.modelAnswer.includes(token),
        ),
        true,
        `${evaluationCase.name}の模範解答にコードの具体的根拠がありません。`,
      );
    }

    if ("incompleteAnswer" in evaluationCase) {
      const incompleteResult = await requestEvaluation(
        endpoint,
        origin,
        sourceUrl,
        evaluationCase.code,
        evaluationCase.incompleteAnswer,
      );
      assert.deepEqual(
        incompleteResult.criteria
          .filter(({ applicable }) => applicable)
          .map(({ id }) => id),
        evaluationCase.expectedCriteria,
        `${evaluationCase.name}の不完全回答で適用軸が変わりました。`,
      );
      assert.equal(
        incompleteResult.totalScore <= Math.min(...scores) - MAX_SCORE_SPREAD,
        true,
        `${evaluationCase.name}の不完全回答が十分に減点されませんでした。`,
      );
      assert.equal(
        incompleteResult.gaps.length > 0,
        true,
        `${evaluationCase.name}の不完全回答に不足点がありません。`,
      );
    }

    console.log(
      `${evaluationCase.name}: score=${Math.min(...scores)}-${Math.max(...scores)}, criteria=${applicableCriteria[0]?.join(",")}`,
    );
  }
}

await main();
