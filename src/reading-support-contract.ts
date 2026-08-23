(() => {
  const errorCodes = new Set([
    "INVALID_JSON",
    "VALIDATION_ERROR",
    "UNAUTHORIZED",
    "PAYLOAD_TOO_LARGE",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
    "READING_SUPPORT_MODEL_ERROR",
    "READING_SUPPORT_TIMEOUT",
  ]);

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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

  function isText(value: unknown, maximum: number): value is string {
    return (
      typeof value === "string" &&
      value.trim().length > 0 &&
      Array.from(value).length <= maximum
    );
  }

  function isTextList(value: unknown, allowEmpty: boolean): value is string[] {
    return (
      Array.isArray(value) &&
      value.length <= 5 &&
      (allowEmpty || value.length > 0) &&
      value.every((item) => isText(item, 700))
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
    return (
      year >= 1 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
      Number(hourText) <= 23 &&
      Number(minuteText) <= 59 &&
      Number(secondText) <= 59 &&
      (offsetHourText === undefined || Number(offsetHourText) <= 23) &&
      (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59)
    );
  }

  function parseResponse(value: unknown): ReadingSupportResponse | null {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "requestId",
        "contractVersion",
        "stage",
        "focusPoints",
        "checks",
        "questions",
        "hints",
        "nextCandidates",
        "detailedExplanation",
        "generatedAt",
      ]) ||
      !isUuid(value.requestId) ||
      value.contractVersion !== "1.0" ||
      (value.stage !== "guide" && value.stage !== "detailed_explanation") ||
      !isDateTime(value.generatedAt) ||
      !Array.isArray(value.nextCandidates) ||
      value.nextCandidates.length > 5 ||
      !value.nextCandidates.every(
        (candidate) =>
          isRecord(candidate) &&
          hasExactKeys(candidate, ["symbol", "reason"]) &&
          isText(candidate.symbol, 200) &&
          isText(candidate.reason, 700),
      )
    ) {
      return null;
    }

    const guide = value.stage === "guide";
    if (
      !isTextList(value.focusPoints, !guide) ||
      !isTextList(value.checks, !guide) ||
      !isTextList(value.questions, !guide) ||
      !isTextList(value.hints, !guide)
    ) {
      return null;
    }
    if (
      (guide && value.detailedExplanation !== null) ||
      (!guide && !isText(value.detailedExplanation, 5_000)) ||
      (!guide &&
        (
          [
            value.focusPoints,
            value.checks,
            value.questions,
            value.hints,
            value.nextCandidates,
          ] as unknown[][]
        ).some((items) => items.length !== 0))
    ) {
      return null;
    }
    return value as unknown as ReadingSupportResponse;
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
      !isText(error.message, 500) ||
      typeof error.retryable !== "boolean" ||
      !Array.isArray(error.details) ||
      error.details.length > 20 ||
      !error.details.every(
        (detail) =>
          isRecord(detail) &&
          hasExactKeys(detail, ["field", "reason"]) &&
          isText(detail.field, 100) &&
          isText(detail.reason, 500),
      )
    ) {
      return null;
    }
    const retryable = ![
      "INVALID_JSON",
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "PAYLOAD_TOO_LARGE",
    ].includes(error.code as string);
    if (error.retryable !== retryable) return null;
    if (error.code === "RATE_LIMITED") {
      if (
        !Number.isInteger(error.retryAfterSeconds) ||
        (error.retryAfterSeconds as number) < 1
      ) {
        return null;
      }
    } else if ("retryAfterSeconds" in error) {
      return null;
    }
    return error as unknown as EvaluationWorkerError;
  }

  globalThis.CodeReadingTrainerReadingSupportContract = Object.freeze({
    parseError,
    parseResponse,
  });
})();
