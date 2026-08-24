import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const [
  backgroundSource,
  configSource,
  contractSource,
  readingContractSource,
  responseExample,
  readingResponseExample,
] = await Promise.all([
  readFile(
    path.join(process.cwd(), "dist/extension/src/background.js"),
    "utf8",
  ),
  readFile(
    path.join(process.cwd(), "dist/extension/src/evaluation-config.js"),
    "utf8",
  ),
  readFile(
    path.join(process.cwd(), "dist/extension/src/evaluation-contract.js"),
    "utf8",
  ),
  readFile(
    path.join(process.cwd(), "dist/extension/src/reading-support-contract.js"),
    "utf8",
  ),
  readFile(
    path.join(process.cwd(), "contracts/evaluation/v1/examples/response.json"),
    "utf8",
  ).then(JSON.parse),
  readFile(
    path.join(
      process.cwd(),
      "contracts/reading-support/v1/examples/response-guide.json",
    ),
    "utf8",
  ).then(JSON.parse),
]);

const apiUrl =
  "https://code-reading-trainer-evaluation-api.test.workers.dev/v1/evaluations";
const readingApiUrl =
  "https://code-reading-trainer-evaluation-api.test.workers.dev/v1/reading-support";
const extensionId = "test-extension-id";
const sidepanelUrl = `chrome-extension://${extensionId}/src/sidepanel.html`;

interface MockFetchInit {
  body: string;
  headers: Record<string, string>;
  method: string;
  signal: AbortSignal;
}

interface MockResponse {
  json?(): Promise<unknown>;
  ok: boolean;
}

interface BackgroundEnvironmentOptions {
  candidateTabContext?: Record<string, unknown> | null;
  configuredUrl?: string | null;
  fetchImpl?: (
    url: string,
    init: MockFetchInit,
  ) => MockResponse | Promise<MockResponse>;
  setTimeoutImpl?: (callback: () => void, delay: number) => unknown;
}

function createBackgroundEnvironment({
  candidateTabContext = null,
  configuredUrl = null,
  fetchImpl = async () => {
    throw new Error("unexpected fetch");
  },
  setTimeoutImpl = setTimeout,
}: BackgroundEnvironmentOptions = {}) {
  let messageListener;
  const fetchCalls: Array<[string, MockFetchInit]> = [];
  const context = vm.createContext({
    AbortController,
    Array,
    Date,
    Number,
    Object,
    Set,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    URL,
    chrome: {
      runtime: {
        getURL(pathname) {
          return `chrome-extension://${extensionId}/${pathname}`;
        },
        id: extensionId,
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
      },
      sidePanel: { setPanelBehavior() {} },
      tabs: {
        async get() {
          return { id: 1, url: candidateTabContext?.url };
        },
        async sendMessage() {
          return candidateTabContext;
        },
      },
    },
    clearTimeout,
    async fetch(url: string, init: MockFetchInit) {
      fetchCalls.push([url, init]);
      return fetchImpl(url, init);
    },
    importScripts() {},
    setTimeout: setTimeoutImpl,
  });

  vm.runInContext(configSource, context);
  context.CodeReadingTrainerEvaluationConfig = Object.freeze({
    getEvaluationApiUrl: () => configuredUrl,
    getReadingSupportApiUrl: () =>
      configuredUrl === null ? null : readingApiUrl,
  });
  vm.runInContext(contractSource, context);
  vm.runInContext(readingContractSource, context);
  vm.runInContext(backgroundSource, context);

  return {
    fetchCalls,
    send(message, sender = { id: extensionId, url: sidepanelUrl }) {
      let resolveResponse;
      const response = new Promise((resolve) => {
        resolveResponse = resolve;
      });
      const keepsChannelOpen = messageListener(
        message,
        sender,
        resolveResponse,
      );
      return {
        keepsChannelOpen,
        response: keepsChannelOpen ? response : Promise.resolve(undefined),
      };
    },
  };
}

function evaluationMessage(overrides = {}) {
  return {
    type: "EVALUATE_ANSWER",
    request: {
      language: "python",
      sourceUrl: "https://github.com/example/project/blob/main/example.py",
      code: "return value",
      explanation: "値を返します。",
      ...overrides,
    },
  };
}

function readingMessage(overrides = {}) {
  return {
    type: "REQUEST_READING_SUPPORT",
    request: {
      language: "python",
      sourceUrl: "https://github.com/example/project/blob/main/example.py",
      code: "return value",
      question: "value の流れを理解したい",
      stage: "guide",
      ...overrides,
    },
  };
}

function candidatesMessage(overrides = {}) {
  return {
    type: "REQUEST_TRAINING_CANDIDATES",
    tabId: 1,
    requestId: "candidate-request-1",
    context: {
      commitOid: "a".repeat(40),
      path: "example.py",
      ref: "main",
      repository: "example/project",
      status: "eligible",
      url: "https://github.com/example/project/blob/main/example.py",
      ...overrides,
    },
  };
}

function jsonResponse(body, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return structuredClone(body);
    },
  };
}

test("評価メッセージ以外は処理しない", async () => {
  const environment = createBackgroundEnvironment();
  const result = environment.send({ type: "PAGE_CONTEXT_CHANGED" });

  assert.equal(result.keepsChannelOpen, false);
  assert.equal(await result.response, undefined);
  assert.equal(environment.fetchCalls.length, 0);
});

test("GitHubのimmutable commitからPython候補を抽出して返す", async () => {
  const source = [
    "def normalize(value):",
    "    result = str(value)",
    "    if not result:",
    "        return None",
    "    return result",
  ].join("\n");
  const environment = createBackgroundEnvironment({
    candidateTabContext: candidatesMessage().context,
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/plain" : null;
        },
      },
      body: null,
      async arrayBuffer() {
        return new TextEncoder().encode(source).buffer;
      },
    }),
  });

  const response = await environment.send(candidatesMessage()).response;

  assert.equal(response.ok, true);
  assert.equal(response.candidates.length, 1);
  assert.equal(response.candidates[0].name, "normalize");
  assert.equal(
    response.candidates[0].sourceUrl,
    `https://github.com/example/project/blob/${"a".repeat(40)}/example.py`,
  );
  assert.match(environment.fetchCalls[0][0].toString(), /ref=a{40}$/u);
});

test("候補contextが現在のタブと一致しなければGitHubへ接続しない", async () => {
  const environment = createBackgroundEnvironment({
    candidateTabContext: {
      ...candidatesMessage().context,
      commitOid: "b".repeat(40),
    },
  });

  const response = await environment.send(candidatesMessage()).response;

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_CONTEXT");
  assert.equal(environment.fetchCalls.length, 0);
});

test("サイドパネル以外からの評価メッセージを拒否する", async () => {
  const environment = createBackgroundEnvironment({ configuredUrl: apiUrl });
  const result = environment.send(evaluationMessage(), {
    id: extensionId,
    url: `chrome-extension://${extensionId}/src/content.js`,
  });

  assert.equal(result.keepsChannelOpen, false);
  assert.equal(await result.response, undefined);
  assert.equal(environment.fetchCalls.length, 0);
});

test("不正な評価リクエストは外部送信前に拒否する", async () => {
  const environment = createBackgroundEnvironment({ configuredUrl: apiUrl });
  const result = environment.send(evaluationMessage({ code: "  " }));

  assert.equal(result.keepsChannelOpen, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await result.response)), {
    ok: false,
    error: {
      code: "VALIDATION_ERROR",
      message: "評価するコードと回答を確認してください。",
      retryable: false,
    },
  });
  assert.equal(environment.fetchCalls.length, 0);
});

test("接続先未設定時は回答を外部送信せず明示的なエラーを返す", async () => {
  const environment = createBackgroundEnvironment();
  const result = environment.send(evaluationMessage());

  assert.equal(result.keepsChannelOpen, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await result.response)), {
    ok: false,
    error: {
      code: "API_NOT_CONFIGURED",
      message: "評価APIの接続先が設定されていません。",
      retryable: false,
    },
  });
  assert.equal(environment.fetchCalls.length, 0);
});

test("固定された評価APIへ1回だけPOSTし、契約に適合する結果を返す", async () => {
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: async () => jsonResponse(responseExample),
  });
  const message = evaluationMessage();
  const result = environment.send(message);

  assert.deepEqual(JSON.parse(JSON.stringify(await result.response)), {
    ok: true,
    response: responseExample,
  });
  assert.equal(environment.fetchCalls.length, 1);
  const [requestedUrl, init] = environment.fetchCalls[0];
  assert.equal(requestedUrl, apiUrl);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(JSON.stringify(init.headers)), {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(init.body), message.request);
  assert.ok(init.signal instanceof AbortSignal);
});

test("APIエラー契約を画面状態へ渡す", async () => {
  const errorBody = {
    requestId: "d877eb02-05a7-4d4d-a049-026fb3469e2f",
    contractVersion: "1.0",
    error: {
      code: "RATE_LIMITED",
      message: "利用回数の上限に達しました。",
      details: [],
      retryable: true,
      retryAfterSeconds: 60,
    },
  };
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: async () => jsonResponse(errorBody, { ok: false }),
  });

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(await environment.send(evaluationMessage()).response),
    ),
    {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        details: [],
        message: "利用回数の上限に達しました。",
        retryable: true,
        retryAfterSeconds: 60,
      },
    },
  );
});

test("契約に適合しない成功レスポンスを表示しない", async () => {
  const invalidResponse = structuredClone(responseExample);
  invalidResponse.totalScore += 1;
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: async () => jsonResponse(invalidResponse),
  });

  const response = await environment.send(evaluationMessage()).response;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_API_RESPONSE");
});

test("36秒で評価API通信を中断し、再試行可能なエラーを返す", async () => {
  let timeoutDelay;
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    setTimeoutImpl(callback, delay) {
      timeoutDelay = delay;
      queueMicrotask(callback);
      return 1;
    },
  });

  const response = await environment.send(evaluationMessage()).response;
  assert.equal(timeoutDelay, 36_000);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "EVALUATION_TIMEOUT");
  assert.equal(response.error.retryable, true);
  assert.equal(environment.fetchCalls.length, 1);
});

test("レスポンス本文の読み取りも36秒で中断する", async () => {
  let fireTimeout;
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: async (_url, init) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          queueMicrotask(fireTimeout);
        }),
    }),
    setTimeoutImpl(callback) {
      fireTimeout = callback;
      return 1;
    },
  });

  const response = await environment.send(evaluationMessage()).response;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "EVALUATION_TIMEOUT");
});

test("並行する同一回答は1回の評価API通信を共有する", async () => {
  let finishFetch;
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: () =>
      new Promise((resolve) => {
        finishFetch = resolve;
      }),
  });

  const first = environment.send(evaluationMessage());
  const second = environment.send(evaluationMessage());
  await Promise.resolve();
  assert.equal(environment.fetchCalls.length, 1);

  finishFetch(jsonResponse(responseExample));
  const [firstResponse, secondResponse] = await Promise.all([
    first.response,
    second.response,
  ]);
  assert.equal(firstResponse.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(secondResponse)),
    JSON.parse(JSON.stringify(firstResponse)),
  );
});

test("読解サポートは専用URLへ専用リクエストをPOSTする", async () => {
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: async () => jsonResponse(readingResponseExample),
  });
  const message = readingMessage();
  const result = await environment.send(message).response;

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    response: readingResponseExample,
  });
  assert.equal(environment.fetchCalls.length, 1);
  assert.equal(environment.fetchCalls[0][0], readingApiUrl);
  assert.deepEqual(
    JSON.parse(environment.fetchCalls[0][1].body),
    message.request,
  );
});

test("読解サポートの空質問は外部送信前に拒否する", async () => {
  const environment = createBackgroundEnvironment({ configuredUrl: apiUrl });
  const result = await environment.send(readingMessage({ question: " " }))
    .response;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VALIDATION_ERROR");
  assert.equal(environment.fetchCalls.length, 0);
});

test("並行する同じ読解リクエストは1回のAPI通信を共有する", async () => {
  let finishFetch;
  const environment = createBackgroundEnvironment({
    configuredUrl: apiUrl,
    fetchImpl: () =>
      new Promise((resolve) => {
        finishFetch = resolve;
      }),
  });
  const first = environment.send(readingMessage());
  const second = environment.send(readingMessage());
  await Promise.resolve();
  assert.equal(environment.fetchCalls.length, 1);
  finishFetch(jsonResponse(readingResponseExample));
  const [one, two] = await Promise.all([first.response, second.response]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(one)),
    JSON.parse(JSON.stringify(two)),
  );
});
