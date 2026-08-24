import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const evaluationConfigSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/evaluation-config.js"),
  "utf8",
);

test("通常ビルドでは評価API URLと接続許可先を設定しない", () => {
  const context = vm.createContext({ Object, URL });
  vm.runInContext(evaluationConfigSource, context);

  assert.equal(
    context.CodeReadingTrainerEvaluationConfig.getEvaluationApiUrl(),
    null,
  );
  assert.equal(
    context.CodeReadingTrainerEvaluationConfig.getReadingSupportApiUrl(),
    null,
  );
  assert.equal(
    context.CodeReadingTrainerEvaluationConfig.getEvaluationApiPermissionOrigin(),
    null,
  );
  assert.ok(Object.isFrozen(context.CodeReadingTrainerEvaluationConfig));
  assert.deepEqual(Object.keys(context.CodeReadingTrainerEvaluationConfig), [
    "getEvaluationApiPermissionOrigin",
    "getEvaluationApiUrl",
    "getReadingSupportApiUrl",
  ]);
  assert.doesNotMatch(evaluationConfigSource, /chrome\.storage|onMessage/u);
});
