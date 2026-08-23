import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReadingSupportResponse,
  validateModelDetailedExplanation,
  validateModelReadingGuide,
} from "../api/reading-support.ts";

const guide = {
  focusPoints: ["value の流れに注目します。"],
  checks: ["value の入力元を確認します。"],
  questions: ["value は何を表しますか？"],
  hints: ["return value を追います。"],
  nextCandidates: [{ symbol: "value", reason: "定義を確認するためです。" }],
};

test("ガイドの固定キー・件数・候補形式を検証する", () => {
  assert.equal(validateModelReadingGuide(guide), true);
  assert.equal(validateModelReadingGuide({ ...guide, unknown: true }), false);
  assert.equal(validateModelReadingGuide({ ...guide, hints: [] }), false);
  assert.equal(
    validateModelReadingGuide({
      ...guide,
      nextCandidates: [{ symbol: "value" }],
    }),
    false,
  );
});

test("詳しい説明は専用の固定JSONだけを受け付ける", () => {
  assert.equal(
    validateModelDetailedExplanation({
      detailedExplanation: "value を返します。",
    }),
    true,
  );
  assert.equal(
    validateModelDetailedExplanation({
      detailedExplanation: "value を返します。",
      hints: [],
    }),
    false,
  );
});

test("支援段階ごとに固定レスポンスへ変換する", () => {
  const id = "57d8d07a-2596-4f11-851d-ace9b27b25d1";
  const now = new Date("2026-08-24T00:00:00Z");
  const guideResponse = buildReadingSupportResponse(guide, "guide", id, now);
  assert.equal(guideResponse.detailedExplanation, null);
  assert.deepEqual(guideResponse.focusPoints, guide.focusPoints);

  const detailResponse = buildReadingSupportResponse(
    { detailedExplanation: "return は value を返します。" },
    "detailed_explanation",
    id,
    now,
  );
  assert.deepEqual(detailResponse.focusPoints, []);
  assert.equal(
    detailResponse.detailedExplanation,
    "return は value を返します。",
  );
});
