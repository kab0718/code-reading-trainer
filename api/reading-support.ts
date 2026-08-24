export const READING_SUPPORT_CONTRACT_VERSION = "1.0";

export type ReadingSupportStage = "guide" | "detailed_explanation";

export interface ReadingSupportInput {
  code: string;
  language: "python";
  sourceUrl: string;
  stage: ReadingSupportStage;
}

export interface ReadingSupportCandidate {
  reason: string;
  symbol: string;
}

export interface ModelReadingGuide {
  checks: string[];
  focusPoints: string[];
  hints: string[];
  nextCandidates: ReadingSupportCandidate[];
  questions: string[];
}

export interface ModelDetailedExplanation {
  detailedExplanation: string;
}

export type ModelReadingSupport = ModelReadingGuide | ModelDetailedExplanation;

export interface ReadingSupportResponse {
  checks: string[];
  contractVersion: "1.0";
  detailedExplanation: string | null;
  focusPoints: string[];
  generatedAt: string;
  hints: string[];
  nextCandidates: ReadingSupportCandidate[];
  questions: string[];
  requestId: string;
  stage: ReadingSupportStage;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maximum
  );
}

function isTextList(value: unknown, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 5 &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => isBoundedText(item, 700))
  );
}

export function validateModelReadingGuide(
  value: unknown,
): value is ModelReadingGuide {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "focusPoints",
      "checks",
      "questions",
      "hints",
      "nextCandidates",
    ]) ||
    !isTextList(value.focusPoints) ||
    !isTextList(value.checks) ||
    !isTextList(value.questions) ||
    !isTextList(value.hints) ||
    !Array.isArray(value.nextCandidates) ||
    value.nextCandidates.length > 5
  ) {
    return false;
  }

  return value.nextCandidates.every(
    (candidate) =>
      isPlainObject(candidate) &&
      hasExactKeys(candidate, ["symbol", "reason"]) &&
      isBoundedText(candidate.symbol, 200) &&
      isBoundedText(candidate.reason, 700),
  );
}

export function validateModelDetailedExplanation(
  value: unknown,
): value is ModelDetailedExplanation {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["detailedExplanation"]) &&
    isBoundedText(value.detailedExplanation, 5_000)
  );
}

export function buildReadingSupportResponse(
  modelOutput: unknown,
  stage: ReadingSupportStage,
  requestId: string,
  now = new Date(),
): ReadingSupportResponse {
  const base = {
    requestId,
    contractVersion: READING_SUPPORT_CONTRACT_VERSION,
    stage,
    generatedAt: now.toISOString(),
  } as const;

  if (stage === "guide") {
    if (!validateModelReadingGuide(modelOutput)) {
      throw new Error("The model guide does not satisfy the expected schema.");
    }
    return { ...base, ...modelOutput, detailedExplanation: null };
  }

  if (!validateModelDetailedExplanation(modelOutput)) {
    throw new Error(
      "The detailed explanation does not satisfy the expected schema.",
    );
  }
  return {
    ...base,
    focusPoints: [],
    checks: [],
    questions: [],
    hints: [],
    nextCandidates: [],
    detailedExplanation: modelOutput.detailedExplanation,
  };
}
