(() => {
  const criteria = Object.freeze([
    ["purpose", "目的・責務", 25],
    ["inputs_outputs", "入出力", 15],
    ["main_flow", "主要処理", 25],
    ["branches_errors", "分岐・例外", 15],
    ["side_effects", "副作用", 10],
    ["assumptions_dependencies", "前提・依存", 10],
  ] as const);
  const errorCodes = new Set([
    "INVALID_JSON",
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "PAYLOAD_TOO_LARGE",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
    "MODEL_ERROR",
    "EVALUATION_TIMEOUT",
  ]);

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function hasExactKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
  ): boolean {
    return (
      required.every((key) => key in value) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      )
    );
  }

  function isString(value: unknown, maximum: number): value is string {
    return (
      typeof value === "string" && value.length > 0 && value.length <= maximum
    );
  }

  function isUuid(value: unknown): value is string {
    return (
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )
    );
  }

  function isDateTime(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
        value,
      );
    if (!match) return false;

    const [
      ,
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
      secondText,
      offsetHourText,
      offsetMinuteText,
    ] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return (
      year >= 1 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth &&
      Number(hourText) <= 23 &&
      Number(minuteText) <= 59 &&
      Number(secondText) <= 59 &&
      (offsetHourText === undefined || Number(offsetHourText) <= 23) &&
      (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59)
    );
  }

  function parseResponse(value: unknown): EvaluationResponse | null {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "requestId",
        "contractVersion",
        "totalScore",
        "criteria",
        "strengths",
        "gaps",
        "modelAnswer",
        "evaluatedAt",
      ]) ||
      !isUuid(value.requestId) ||
      value.contractVersion !== "1.0" ||
      !Number.isInteger(value.totalScore) ||
      (value.totalScore as number) < 0 ||
      (value.totalScore as number) > 100 ||
      !Array.isArray(value.criteria) ||
      value.criteria.length !== criteria.length ||
      !Array.isArray(value.strengths) ||
      value.strengths.length > 5 ||
      !value.strengths.every((item) => isString(item, 500)) ||
      !Array.isArray(value.gaps) ||
      value.gaps.length > 5 ||
      !value.gaps.every((item) => isString(item, 500)) ||
      !isString(value.modelAnswer, 5_000) ||
      !isDateTime(value.evaluatedAt)
    ) {
      return null;
    }

    let scoreTotal = 0;
    let maximumTotal = 0;
    for (const [index, definition] of criteria.entries()) {
      const item: unknown = value.criteria[index];
      if (
        !isRecord(item) ||
        !hasExactKeys(item, [
          "id",
          "label",
          "applicable",
          "baseWeight",
          "score",
          "maxScore",
          "feedback",
          "exclusionReason",
        ]) ||
        item.id !== definition[0] ||
        item.label !== definition[1] ||
        item.baseWeight !== definition[2] ||
        typeof item.applicable !== "boolean" ||
        !Number.isInteger(item.maxScore) ||
        (item.maxScore as number) < 0 ||
        (item.maxScore as number) > 100
      ) {
        return null;
      }

      const maximum = item.maxScore as number;
      maximumTotal += maximum;
      if (item.applicable) {
        if (
          maximum < 1 ||
          !Number.isInteger(item.score) ||
          (item.score as number) < 0 ||
          (item.score as number) > maximum ||
          !isString(item.feedback, 1_000) ||
          item.exclusionReason !== null
        ) {
          return null;
        }
        scoreTotal += item.score as number;
      } else if (
        item.score !== null ||
        maximum !== 0 ||
        item.feedback !== null ||
        !isString(item.exclusionReason, 500)
      ) {
        return null;
      }
    }

    return maximumTotal === 100 && scoreTotal === value.totalScore
      ? (value as unknown as EvaluationResponse)
      : null;
  }

  function parseError(value: unknown): EvaluationWorkerError | null {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["requestId", "contractVersion", "error"]) ||
      !isUuid(value.requestId) ||
      value.contractVersion !== "1.0" ||
      !isRecord(value.error)
    ) {
      return null;
    }

    const error = value.error;
    if (
      !hasExactKeys(
        error,
        ["code", "message", "details", "retryable"],
        ["retryAfterSeconds"],
      ) ||
      typeof error.code !== "string" ||
      !errorCodes.has(error.code) ||
      !isString(error.message, 500) ||
      typeof error.retryable !== "boolean" ||
      !Array.isArray(error.details) ||
      error.details.length > 20 ||
      !error.details.every(
        (detail) =>
          isRecord(detail) &&
          hasExactKeys(detail, ["field", "reason"]) &&
          isString(detail.field, 100) &&
          isString(detail.reason, 500),
      )
    ) {
      return null;
    }

    const retryable = ![
      "INVALID_JSON",
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "PAYLOAD_TOO_LARGE",
    ].includes(error.code);
    if (error.retryable !== retryable) return null;

    if (
      error.code === "RATE_LIMITED" &&
      (!Number.isInteger(error.retryAfterSeconds) ||
        (error.retryAfterSeconds as number) < 1)
    ) {
      return null;
    }
    if (error.code !== "RATE_LIMITED" && "retryAfterSeconds" in error) {
      return null;
    }

    return {
      code: error.code,
      details: error.details as Array<{ field: string; reason: string }>,
      message: error.message,
      retryable: error.retryable,
      ...(typeof error.retryAfterSeconds === "number"
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }

  globalThis.CodeReadingTrainerEvaluationContract = Object.freeze({
    parseError,
    parseResponse,
  });
})();
