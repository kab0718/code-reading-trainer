import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const [contractSource, responseExample, errorExample] = await Promise.all([
  readFile(
    path.join(process.cwd(), "dist/extension/src/evaluation-contract.js"),
    "utf8",
  ),
  readFile(
    path.join(process.cwd(), "contracts/evaluation/v1/examples/response.json"),
    "utf8",
  ).then(JSON.parse),
  readFile(
    path.join(process.cwd(), "contracts/evaluation/v1/examples/error.json"),
    "utf8",
  ).then(JSON.parse),
]);

function loadContract() {
  const context = vm.createContext({ Date, Number, Object, Set });
  vm.runInContext(contractSource, context);
  return context.CodeReadingTrainerEvaluationContract;
}

test("整合するv1評価レスポンスだけを受け付ける", () => {
  const contract = loadContract();

  assert.ok(contract.parseResponse(responseExample));

  const inconsistentScore = structuredClone(responseExample);
  inconsistentScore.totalScore += 1;
  assert.equal(contract.parseResponse(inconsistentScore), null);

  const unexpectedField = { ...responseExample, rawModelOutput: "secret" };
  assert.equal(contract.parseResponse(unexpectedField), null);
});

test("v1エラー契約と再試行条件を検証する", () => {
  const contract = loadContract();

  assert.deepEqual(
    JSON.parse(JSON.stringify(contract.parseError(errorExample))),
    {
      code: "VALIDATION_ERROR",
      details: [
        {
          field: "explanation",
          reason: "1文字以上で入力してください。",
        },
      ],
      message: "リクエストの入力値を確認してください。",
      retryable: false,
    },
  );

  const invalidRetry = structuredClone(errorExample);
  invalidRetry.error.retryable = true;
  assert.equal(contract.parseError(invalidRetry), null);

  const rateLimited = structuredClone(errorExample);
  rateLimited.error = {
    code: "RATE_LIMITED",
    message: "しばらく待ってください。",
    details: [],
    retryable: true,
    retryAfterSeconds: 60,
  };
  assert.equal(contract.parseError(rateLimited)?.retryAfterSeconds, 60);
});

test("date-timeではない評価日時を拒否する", () => {
  const contract = loadContract();
  const dateOnly = structuredClone(responseExample);
  dateOnly.evaluatedAt = "2026-08-16";
  const nonexistentDate = structuredClone(responseExample);
  nonexistentDate.evaluatedAt = "2026-02-30T00:00:00Z";

  assert.equal(contract.parseResponse(dateOnly), null);
  assert.equal(contract.parseResponse(nonexistentDate), null);
});
