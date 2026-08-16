import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(
  path.join(process.cwd(), "src/input-validation.js"),
  "utf8",
);

function loadValidation() {
  const context = vm.createContext({ Array, Object });
  vm.runInContext(source, context);
  return context.CodeReadingTrainerInputValidation;
}

test("選択コードと回答の必須入力を検証する", () => {
  const { validateTrainingInput } = loadValidation();

  const missingCode = validateTrainingInput(" \n", "説明");
  assert.equal(missingCode.valid, false);
  assert.match(missingCode.codeError, /Pythonコードを選択/u);

  const missingExplanation = validateTrainingInput("print('ok')", " \n");
  assert.equal(missingExplanation.valid, false);
  assert.match(missingExplanation.explanationError, /回答を入力/u);
});

test("コード30,000文字と回答5,000文字の上限を検証する", () => {
  const { INPUT_LIMITS, validateTrainingInput } = loadValidation();
  assert.equal(INPUT_LIMITS.code, 30_000);
  assert.equal(INPUT_LIMITS.explanation, 5_000);

  const withinLimits = validateTrainingInput(
    "x".repeat(INPUT_LIMITS.code),
    "あ".repeat(INPUT_LIMITS.explanation),
  );
  const overLimits = validateTrainingInput(
    "x".repeat(INPUT_LIMITS.code + 1),
    "あ".repeat(INPUT_LIMITS.explanation + 1),
  );

  assert.equal(withinLimits.valid, true);
  assert.equal(overLimits.valid, false);
  assert.match(overLimits.codeError, /選択範囲を短く/u);
  assert.match(overLimits.explanationError, /内容を短く/u);
});

test("文字数はUnicodeコードポイント単位で数える", () => {
  const { countCharacters } = loadValidation();

  assert.equal(countCharacters("A😀あ"), 3);
});
