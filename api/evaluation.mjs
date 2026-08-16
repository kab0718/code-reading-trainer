export const CONTRACT_VERSION = "1.0";

export const CRITERIA = Object.freeze([
  { id: "purpose", label: "目的・責務", baseWeight: 25 },
  { id: "inputs_outputs", label: "入出力", baseWeight: 15 },
  { id: "main_flow", label: "主要処理", baseWeight: 25 },
  { id: "branches_errors", label: "分岐・例外", baseWeight: 15 },
  { id: "side_effects", label: "副作用", baseWeight: 10 },
  {
    id: "assumptions_dependencies",
    label: "前提・依存",
    baseWeight: 10,
  },
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();

  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isBoundedText(value, maximum, nullable = false) {
  if (nullable && value === null) {
    return true;
  }

  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= maximum
  );
}

function isTextList(value) {
  return (
    Array.isArray(value) &&
    value.length <= 5 &&
    value.every((item) => isBoundedText(item, 500))
  );
}

export function validateModelEvaluation(value) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["criteria", "strengths", "gaps", "modelAnswer"])
  ) {
    return false;
  }

  if (
    !Array.isArray(value.criteria) ||
    value.criteria.length !== CRITERIA.length ||
    !isTextList(value.strengths) ||
    !isTextList(value.gaps) ||
    !isBoundedText(value.modelAnswer, 5000)
  ) {
    return false;
  }

  let applicableCount = 0;

  for (const [index, criterion] of value.criteria.entries()) {
    if (
      !isPlainObject(criterion) ||
      !hasExactKeys(criterion, [
        "id",
        "applicable",
        "percentageScore",
        "feedback",
        "exclusionReason",
      ]) ||
      criterion.id !== CRITERIA[index].id ||
      typeof criterion.applicable !== "boolean" ||
      !Number.isInteger(criterion.percentageScore) ||
      criterion.percentageScore < 0 ||
      criterion.percentageScore > 100
    ) {
      return false;
    }

    if (criterion.applicable) {
      applicableCount += 1;
      if (
        !isBoundedText(criterion.feedback, 1000) ||
        criterion.exclusionReason !== null
      ) {
        return false;
      }
    } else if (
      criterion.percentageScore !== 0 ||
      criterion.feedback !== null ||
      !isBoundedText(criterion.exclusionReason, 500)
    ) {
      return false;
    }
  }

  return applicableCount > 0;
}

export function allocateMaximumScores(applicableIds) {
  const applicable = CRITERIA.filter(({ id }) => applicableIds.has(id));
  const weightSum = applicable.reduce(
    (sum, criterion) => sum + criterion.baseWeight,
    0,
  );

  if (weightSum === 0) {
    throw new Error("At least one evaluation criterion must be applicable.");
  }

  const allocations = applicable.map((criterion, index) => {
    const exact = (100 * criterion.baseWeight) / weightSum;
    return {
      id: criterion.id,
      index,
      maximum: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  const allocated = allocations.reduce((sum, item) => sum + item.maximum, 0);
  const remainderOrder = [...allocations].sort(
    (left, right) =>
      right.remainder - left.remainder || left.index - right.index,
  );

  for (let index = 0; index < 100 - allocated; index += 1) {
    remainderOrder[index].maximum += 1;
  }

  return new Map(allocations.map(({ id, maximum }) => [id, maximum]));
}

export function buildEvaluationResponse(
  modelEvaluation,
  requestId,
  now = new Date(),
) {
  if (!validateModelEvaluation(modelEvaluation)) {
    throw new Error(
      "The model evaluation does not satisfy the expected schema.",
    );
  }

  const applicableIds = new Set(
    modelEvaluation.criteria
      .filter(({ applicable }) => applicable)
      .map(({ id }) => id),
  );
  const maximumScores = allocateMaximumScores(applicableIds);
  const criteria = CRITERIA.map((definition, index) => {
    const modelCriterion = modelEvaluation.criteria[index];

    if (!modelCriterion.applicable) {
      return {
        ...definition,
        applicable: false,
        score: null,
        maxScore: 0,
        feedback: null,
        exclusionReason: modelCriterion.exclusionReason,
      };
    }

    const maxScore = maximumScores.get(definition.id);
    return {
      ...definition,
      applicable: true,
      score: Math.round((maxScore * modelCriterion.percentageScore) / 100),
      maxScore,
      feedback: modelCriterion.feedback,
      exclusionReason: null,
    };
  });

  return {
    requestId,
    contractVersion: CONTRACT_VERSION,
    totalScore: criteria.reduce(
      (sum, criterion) => sum + (criterion.score ?? 0),
      0,
    ),
    criteria,
    strengths: modelEvaluation.strengths,
    gaps: modelEvaluation.gaps,
    modelAnswer: modelEvaluation.modelAnswer,
    evaluatedAt: now.toISOString(),
  };
}
