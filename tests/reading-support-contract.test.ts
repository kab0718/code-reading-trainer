import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  path.join(process.cwd(), "dist/extension/src/reading-support-contract.js"),
  "utf8",
);
const [guide, detail, error] = await Promise.all(
  ["response-guide.json", "response-detail.json", "error.json"].map(
    async (name) =>
      JSON.parse(
        await readFile(
          path.join(
            process.cwd(),
            "contracts/reading-support/v1/examples",
            name,
          ),
          "utf8",
        ),
      ),
  ),
);

function contract() {
  const context = vm.createContext({ Array, Date, Number, Object, Set });
  vm.runInContext(source, context);
  return context.CodeReadingTrainerReadingSupportContract;
}

test("ガイドと詳しい説明の段階別レスポンスを受け付ける", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract().parseResponse(guide))),
    guide,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract().parseResponse(detail))),
    detail,
  );
});

test("ガイド段階の詳しい説明と詳細段階のガイド混在を拒否する", () => {
  assert.equal(
    contract().parseResponse({
      ...guide,
      detailedExplanation: "先取りした説明",
    }),
    null,
  );
  assert.equal(
    contract().parseResponse({ ...detail, hints: ["混在したヒント"] }),
    null,
  );
});

test("専用エラー契約を読み取る", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(contract().parseError(error))),
    error.error,
  );
});

test("再試行可否とRetry-Afterの規則に反するエラーを拒否する", () => {
  assert.equal(
    contract().parseError({
      ...error,
      error: { ...error.error, retryable: true },
    }),
    null,
  );
  assert.equal(
    contract().parseError({
      ...error,
      error: {
        ...error.error,
        code: "RATE_LIMITED",
        retryable: true,
      },
    }),
    null,
  );
  assert.equal(
    contract().parseError({
      ...error,
      error: {
        ...error.error,
        details: Array.from({ length: 21 }, () => ({
          field: "question",
          reason: "入力を確認してください。",
        })),
      },
    }),
    null,
  );
});

test("date-timeではない生成日時を拒否する", () => {
  assert.equal(
    contract().parseResponse({ ...guide, generatedAt: "2026-08-24" }),
    null,
  );
  assert.equal(
    contract().parseResponse({ ...guide, generatedAt: "2026-02-30T00:00:00Z" }),
    null,
  );
});
