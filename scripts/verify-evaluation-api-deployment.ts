import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

const verifyRateLimit = process.env.EVALUATION_VERIFY_RATE_LIMIT === "true";
const verifySuccess = process.env.EVALUATION_VERIFY_SUCCESS !== "false";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name}を指定してください。`);
  return value;
}

const endpoint = requiredEnvironmentVariable("EVALUATION_API_URL");
const allowedOrigin = requiredEnvironmentVariable("EVALUATION_TEST_ORIGIN");
const sourceUrl = requiredEnvironmentVariable("EVALUATION_TEST_SOURCE_URL");

const contractRoot = path.join(process.cwd(), "contracts/evaluation/v1");
const [responseSchema, errorSchema] = await Promise.all([
  readFile(
    path.join(contractRoot, "evaluation-response.schema.json"),
    "utf8",
  ).then(JSON.parse),
  readFile(
    path.join(contractRoot, "evaluation-error.schema.json"),
    "utf8",
  ).then(JSON.parse),
]);
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateResponse = ajv.compile(responseSchema);
const validateError = ajv.compile(errorSchema);

const validRequest = {
  language: "python",
  sourceUrl,
  code: "def normalize_name(name):\n    return name.strip().lower()",
  explanation: "nameの前後の空白を除去し、小文字にして返します。",
};

interface VerificationResult {
  body: unknown;
  response: Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRequestId(body: unknown): string {
  return isRecord(body) && typeof body.requestId === "string"
    ? body.requestId
    : "none";
}

function report(name: string, result: VerificationResult): void {
  const retryAfter = result.response.headers.get("Retry-After");
  console.log(
    `${name}: status=${result.response.status} requestId=${getRequestId(result.body)}` +
      (retryAfter ? ` retryAfter=${retryAfter}` : ""),
  );
}

async function requestJson(
  body: string,
  origin: string | null = allowedOrigin,
): Promise<VerificationResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (origin !== null) headers.Origin = origin;

  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(40_000),
    headers,
    body,
  });
  const responseBody: unknown = await response.json();
  return { body: responseBody, response };
}

function assertCors(response: Response): void {
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    allowedOrigin,
  );
  assert.match(response.headers.get("Vary") ?? "", /Origin/u);
}

function assertError(
  result: VerificationResult,
  status: number,
  code: string,
): void {
  assert.equal(result.response.status, status);
  assert.equal(
    validateError(result.body),
    true,
    ajv.errorsText(validateError.errors),
  );
  assert.equal(
    isRecord(result.body) &&
      isRecord(result.body.error) &&
      result.body.error.code,
    code,
  );
}

const preflight = await fetch(endpoint, {
  method: "OPTIONS",
  headers: {
    Origin: allowedOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  },
});
assert.equal(preflight.status, 204);
assertCors(preflight);
console.log("cors-preflight: status=204");

const unauthorized = await requestJson(
  JSON.stringify(validRequest),
  "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
assertError(unauthorized, 401, "UNAUTHORIZED");
assert.equal(
  unauthorized.response.headers.get("Access-Control-Allow-Origin"),
  null,
);
report("unauthorized-origin", unauthorized);

const missingOrigin = await requestJson("{", null);
assertError(missingOrigin, 401, "UNAUTHORIZED");
assert.equal(
  missingOrigin.response.headers.get("Access-Control-Allow-Origin"),
  null,
);
report("missing-origin", missingOrigin);

const invalidJson = await requestJson("{");
assertError(invalidJson, 400, "INVALID_JSON");
assertCors(invalidJson.response);
report("invalid-json", invalidJson);

const nonPython = await requestJson(
  JSON.stringify({ ...validRequest, language: "javascript" }),
);
assertError(nonPython, 400, "VALIDATION_ERROR");
assertCors(nonPython.response);
report("non-python", nonPython);

if (verifySuccess) {
  const successful = await requestJson(JSON.stringify(validRequest));
  report("successful-evaluation", successful);
  assert.equal(successful.response.status, 200);
  assert.equal(
    validateResponse(successful.body),
    true,
    ajv.errorsText(validateResponse.errors),
  );
  assertCors(successful.response);
}

if (verifyRateLimit) {
  const missingSourceRequest = {
    ...validRequest,
    sourceUrl:
      "https://github.com/kab0718/code-reading-trainer/blob/main/does-not-exist.py",
  };

  let rateLimited: VerificationResult | null = null;
  for (let requestNumber = 1; requestNumber <= 20; requestNumber += 1) {
    const missingSource = await requestJson(
      JSON.stringify(missingSourceRequest),
    );
    assertCors(missingSource.response);
    if (missingSource.response.status === 429) {
      assertError(missingSource, 429, "RATE_LIMITED");
      rateLimited = missingSource;
      report(`rate-limited-${requestNumber}`, missingSource);
      break;
    }

    assertError(missingSource, 400, "VALIDATION_ERROR");
    report(`missing-source-${requestNumber}`, missingSource);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(rateLimited, "20回以内にRate Limitが反映されませんでした。");
  assert.equal(rateLimited.response.headers.get("Retry-After"), "60");
  assert.equal(
    isRecord(rateLimited.body) &&
      isRecord(rateLimited.body.error) &&
      rateLimited.body.error.retryAfterSeconds,
    60,
  );
}
