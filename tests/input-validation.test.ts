import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(
  path.join(process.cwd(), "dist/extension/src/input-validation.js"),
  "utf8",
);

function loadValidation() {
  const context = vm.createContext({ Array, Object });
  vm.runInContext(source, context);
  return context.CodeReadingTrainerInputValidation;
}

test("対象コードと回答の必須入力を検証する", () => {
  const { validateTrainingInput } = loadValidation();

  const missingCode = validateTrainingInput(" \n", "説明");
  assert.equal(missingCode.valid, false);
  assert.match(missingCode.codeError, /対象のPythonコードがありません/u);

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
  assert.match(overLimits.codeError, /別の候補/u);
  assert.match(overLimits.explanationError, /内容を短く/u);
});

test("文字数はUnicodeコードポイント単位で数える", () => {
  const { countCharacters } = loadValidation();

  assert.equal(countCharacters("A😀あ"), 3);
});

test("読解サポートの質問必須と2,000文字上限を検証する", () => {
  const { INPUT_LIMITS, validateReadingSupportInput } = loadValidation();
  assert.equal(INPUT_LIMITS.question, 2_000);
  assert.equal(validateReadingSupportInput("return value", " ").valid, false);
  assert.match(
    validateReadingSupportInput("return value", " ").questionError,
    /分からない点または調査目的/u,
  );
  assert.equal(
    validateReadingSupportInput(
      "return value",
      "あ".repeat(INPUT_LIMITS.question),
    ).valid,
    true,
  );
  assert.match(
    validateReadingSupportInput(
      "return value",
      "あ".repeat(INPUT_LIMITS.question + 1),
    ).questionError,
    /内容を短く/u,
  );
});
