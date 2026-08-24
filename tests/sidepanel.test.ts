import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const sidepanelSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/sidepanel.js"),
  "utf8",
);
const inputValidationSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/input-validation.js"),
  "utf8",
);
const evaluationConfigSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/evaluation-config.js"),
  "utf8",
);
const evaluationContractSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/evaluation-contract.js"),
  "utf8",
);
const readingSupportContractSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/reading-support-contract.js"),
  "utf8",
);
const analyticsSource = await readFile(
  path.join(process.cwd(), "dist/extension/src/analytics.js"),
  "utf8",
);
const sidepanelHtmlSource = await readFile(
  path.join(process.cwd(), "src/sidepanel.html"),
  "utf8",
);

function eligibleContext(filePath) {
  return {
    commitOid: "a".repeat(40),
    status: "eligible",
    reason: null,
    url: `https://github.com/example/project/blob/main/${filePath}`,
    repository: "example/project",
    ref: "main",
    path: filePath,
  };
}

function evaluationResponse(totalScore = 82) {
  let remainingScore = totalScore;
  const criteriaDefinitions: ReadonlyArray<readonly [string, string, number]> =
    [
      ["purpose", "目的・責務", 25],
      ["inputs_outputs", "入出力", 15],
      ["main_flow", "主要処理", 25],
      ["branches_errors", "分岐・例外", 15],
      ["side_effects", "副作用", 10],
      ["assumptions_dependencies", "前提・依存", 10],
    ];
  const criteria = criteriaDefinitions.map(([id, label, baseWeight]) => {
    const score = Math.min(baseWeight, remainingScore);
    remainingScore -= score;
    return {
      applicable: true,
      baseWeight,
      exclusionReason: null,
      feedback: `${label}についてのフィードバックです。`,
      id,
      label,
      maxScore: baseWeight,
      score,
    };
  });

  return {
    requestId: "4fd0d833-6bad-4d6e-b2e2-7fd9ba73710b",
    contractVersion: "1.0",
    totalScore,
    criteria,
    strengths: [],
    gaps: [],
    modelAnswer: "模範解答",
    evaluatedAt: "2026-08-16T00:00:00Z",
  };
}

function readingSupportResponse(stage = "guide") {
  return {
    requestId: "57d8d07a-2596-4f11-851d-ace9b27b25d1",
    contractVersion: "1.0",
    stage,
    focusPoints: stage === "guide" ? ["value の流れに注目します。"] : [],
    checks: stage === "guide" ? ["value の入力元を確認します。"] : [],
    questions: stage === "guide" ? ["value はいつ返されますか？"] : [],
    hints: stage === "guide" ? ["return value を追ってみましょう。"] : [],
    nextCandidates:
      stage === "guide"
        ? [{ symbol: "value", reason: "値の定義を確認するためです。" }]
        : [],
    detailedExplanation:
      stage === "detailed_explanation"
        ? "return は value を呼び出し元へ返します。"
        : null,
    generatedAt: "2026-08-24T00:00:00Z",
  };
}

function createSidepanelEnvironment({
  permissionGranted = true,
  permissionOrigin = null,
} = {}) {
  let currentContext = eligibleContext("first.py");
  let pageContextHandler = async () => currentContext;
  let runtimeListener;
  let tabActivatedListener;
  let evaluationHandler = async () => ({
    ok: true,
    response: evaluationResponse(),
  });
  let readingHandler = async (message) => ({
    ok: true,
    response: readingSupportResponse(message.request.stage),
  });
  let candidatesHandler = async (message) => ({
    candidates: [],
    contextKey: JSON.stringify([
      message.context.repository,
      message.context.commitOid,
      message.context.path,
    ]),
    ok: true,
    requestId: message.requestId,
  });
  const evaluationMessages = [];
  const permissionRequests = [];
  let pageContextRequests = 0;
  const timers = new Map();
  let nextTimerId = 1;
  const listeners = new Map();
  const replaceChildrenCounts = new Map();
  const storage: Record<string, unknown> = {};
  interface MockElement {
    [key: string]: unknown;
    disabled?: boolean;
    hidden?: boolean;
    textContent?: string;
    value?: string;
    children?: MockElement[];
    className?: string;
    addEventListener(type: string, listener: unknown): void;
    append(...children: MockElement[]): void;
    replaceChildren(...children: MockElement[]): void;
    setAttribute(name: string, value: string): void;
  }
  const createElement = (
    selector: string,
    properties: Partial<MockElement> = {},
  ): MockElement => ({
    ...properties,
    addEventListener(type, listener) {
      listeners.set(`${selector}:${type}`, listener);
    },
    append(...children) {
      this.children ??= [];
      this.children.push(...children);
    },
    replaceChildren(...children) {
      replaceChildrenCounts.set(
        selector,
        (replaceChildrenCounts.get(selector) ?? 0) + 1,
      );
      this.children = children;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
  });
  const elements: Record<string, MockElement> = {
    "#status": createElement("#status", { textContent: "" }),
    "#training-methods": createElement("#training-methods", {
      hidden: false,
    }),
    "#recommendation-button": createElement("#recommendation-button", {
      disabled: false,
    }),
    "#candidate-section": createElement("#candidate-section", {
      hidden: true,
    }),
    "#candidate-status": createElement("#candidate-status", {
      textContent: "",
    }),
    "#candidate-list": createElement("#candidate-list", { children: [] }),
    "#training-session": createElement("#training-session", { hidden: true }),
    "#selected-code": createElement("#selected-code", { textContent: "" }),
    "#training-input": createElement("#training-input", { hidden: false }),
    "#reading-input": createElement("#reading-input", { hidden: true }),
    "#training-mode-button": createElement("#training-mode-button", {}),
    "#reading-mode-button": createElement("#reading-mode-button", {}),
    "#explanation": createElement("#explanation", { value: "" }),
    "#explanation-count": createElement("#explanation-count", {
      textContent: "",
    }),
    "#input-error": createElement("#input-error", { textContent: "" }),
    "#evaluation-button": createElement("#evaluation-button", {
      disabled: true,
    }),
    "#evaluation-result": createElement("#evaluation-result", {
      hidden: true,
    }),
    "#total-score-value": createElement("#total-score-value", {
      textContent: "",
    }),
    "#criteria-list": createElement("#criteria-list", { children: [] }),
    "#strengths-list": createElement("#strengths-list", { children: [] }),
    "#gaps-list": createElement("#gaps-list", { children: [] }),
    "#user-answer": createElement("#user-answer", { textContent: "" }),
    "#model-answer": createElement("#model-answer", { textContent: "" }),
    "#new-training-button": createElement("#new-training-button", {
      disabled: false,
    }),
    "#reading-question": createElement("#reading-question", { value: "" }),
    "#reading-question-count": createElement("#reading-question-count", {
      textContent: "",
    }),
    "#reading-input-error": createElement("#reading-input-error", {
      textContent: "",
    }),
    "#reading-submit-button": createElement("#reading-submit-button", {
      disabled: true,
    }),
    "#reading-result": createElement("#reading-result", { hidden: true }),
    "#focus-points-list": createElement("#focus-points-list", { children: [] }),
    "#checks-list": createElement("#checks-list", { children: [] }),
    "#reading-questions-list": createElement("#reading-questions-list", {
      children: [],
    }),
    "#hints-list": createElement("#hints-list", { children: [] }),
    "#next-candidates-block": createElement("#next-candidates-block", {
      hidden: false,
    }),
    "#next-candidates-list": createElement("#next-candidates-list", {
      children: [],
    }),
    "#reading-result-error": createElement("#reading-result-error", {
      textContent: "",
    }),
    "#detail-button": createElement("#detail-button", { disabled: false }),
    "#detailed-explanation-block": createElement(
      "#detailed-explanation-block",
      { hidden: true },
    ),
    "#detailed-explanation": createElement("#detailed-explanation", {
      textContent: "",
    }),
    "#complete-reading-button": createElement("#complete-reading-button", {
      disabled: false,
    }),
  };

  const context = vm.createContext({
    Error,
    JSON,
    Date,
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    chrome: {
      permissions: {
        async request(request) {
          permissionRequests.push(request);
          return permissionGranted;
        },
      },
      storage: {
        local: {
          async get(key) {
            return { [key]: storage[key] };
          },
          async set(values) {
            Object.assign(storage, values);
          },
        },
      },
      runtime: {
        async sendMessage(message) {
          if (message.type === "REQUEST_TRAINING_CANDIDATES") {
            return candidatesHandler(message);
          }
          evaluationMessages.push(message);
          if (message.type === "REQUEST_READING_SUPPORT") {
            return readingHandler(message);
          }
          return evaluationHandler();
        },
        onMessage: {
          addListener(listener) {
            runtimeListener = listener;
          },
        },
      },
      tabs: {
        async query() {
          return [
            {
              active: true,
              id: 1,
              url: "https://github.com/example/project/blob/main/first.py",
            },
          ];
        },
        async sendMessage() {
          pageContextRequests += 1;
          return pageContextHandler();
        },
        onActivated: {
          addListener(listener) {
            tabActivatedListener = listener;
          },
        },
        onUpdated: { addListener() {} },
      },
    },
    document: {
      createElement(tagName) {
        return createElement(`<${tagName}>`, { children: [] });
      },
      querySelector(selector) {
        return elements[selector];
      },
    },
    setTimeout(callback) {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
  });

  vm.runInContext(inputValidationSource, context);
  vm.runInContext(evaluationConfigSource, context);
  vm.runInContext(evaluationContractSource, context);
  vm.runInContext(readingSupportContractSource, context);
  vm.runInContext(analyticsSource, context);
  context.CodeReadingTrainerEvaluationConfig = Object.freeze({
    getEvaluationApiPermissionOrigin: () => permissionOrigin,
    getEvaluationApiUrl: () => null,
    getReadingSupportApiUrl: () => null,
  });
  vm.runInContext(sidepanelSource, context);

  return {
    elements,
    async startWithCandidate(code) {
      candidatesHandler = async (message) => ({
        candidates: [
          {
            code,
            difficulty: "初級",
            endLine: 1,
            estimatedMinutes: 5,
            id: "function:example:1",
            kind: "function",
            level: "recommended",
            name: "example",
            reason: "テスト用の候補です。",
            sourceUrl: `https://github.com/${message.context.repository}/blob/${message.context.commitOid}/${message.context.path}`,
            startLine: 1,
          },
        ],
        contextKey: JSON.stringify([
          message.context.repository,
          message.context.commitOid,
          message.context.path,
        ]),
        ok: true,
        requestId: message.requestId,
      });
      await listeners.get("#recommendation-button:click")();
      listeners.get("<button>:click")();
    },
    inputExplanation(value) {
      elements["#explanation"].value = value;
      listeners.get("#explanation:input")();
    },
    chooseReadingMode() {
      return listeners.get("#reading-mode-button:click")();
    },
    requestCandidates() {
      return listeners.get("#recommendation-button:click")();
    },
    chooseRenderedCandidate() {
      return listeners.get("<button>:click")();
    },
    chooseTrainingMode() {
      return listeners.get("#training-mode-button:click")();
    },
    inputReadingQuestion(value) {
      elements["#reading-question"].value = value;
      listeners.get("#reading-question:input")();
    },
    requestReadingGuide() {
      return listeners.get("#reading-submit-button:click")();
    },
    requestDetail() {
      return listeners.get("#detail-button:click")();
    },
    completeReading() {
      return listeners.get("#complete-reading-button:click")();
    },
    submit() {
      let defaultPrevented = false;
      const completion = listeners.get("#training-session:submit")({
        preventDefault() {
          defaultPrevented = true;
        },
      });
      return { completion, defaultPrevented };
    },
    startNewTraining() {
      return listeners.get("#new-training-button:click")();
    },
    evaluationMessages,
    permissionRequests,
    getPageContextRequestCount() {
      return pageContextRequests;
    },
    getReplaceChildrenCount(selector) {
      return replaceChildrenCounts.get(selector) ?? 0;
    },
    setEvaluationHandler(handler) {
      evaluationHandler = handler;
    },
    setReadingHandler(handler) {
      readingHandler = handler;
    },
    setCandidatesHandler(handler) {
      candidatesHandler = handler;
    },
    storage,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    navigate(pageContext) {
      currentContext = pageContext;
      runtimeListener({ type: "PAGE_CONTEXT_CHANGED" });
    },
    activateTab(pageContext) {
      currentContext = pageContext;
      tabActivatedListener({ tabId: 2, windowId: 1 });
    },
    notifyPageContextChanged() {
      runtimeListener({ type: "PAGE_CONTEXT_CHANGED" });
    },
    setPageContextHandler(handler) {
      pageContextHandler = handler;
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

function elementText(element) {
  return `${element.textContent ?? ""}${(element.children ?? [])
    .map(elementText)
    .join("")}`;
}

test("回答フォームで1回限りのルールを明示する", () => {
  assert.match(sidepanelHtmlSource, /回答は1回限りです/u);
  assert.match(sidepanelHtmlSource, /再評価したりすることはできません/u);
});

test("初期画面にGitHub上のテキスト選択導線を表示しない", () => {
  assert.doesNotMatch(sidepanelHtmlSource, /selection-button/u);
  assert.doesNotMatch(sidepanelHtmlSource, /対象コードを読む/u);
});

test("おすすめ候補を選ぶとimmutable URLで既存の採点フローへ渡す", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  const commitOid = "a".repeat(40);
  const sourceUrl = `https://github.com/example/project/blob/${commitOid}/first.py`;
  const candidateCode =
    "def normalize(value):\n    result = str(value)\n    return result";
  environment.setCandidatesHandler(async (message) => ({
    candidates: [
      {
        code: candidateCode,
        difficulty: "初級",
        endLine: 3,
        estimatedMinutes: 5,
        id: "function:normalize:1",
        kind: "function",
        level: "recommended",
        name: "normalize",
        reason: "処理の流れを追いやすい候補です。",
        sourceUrl,
        startLine: 1,
      },
    ],
    contextKey: JSON.stringify([
      message.context.repository,
      message.context.commitOid,
      message.context.path,
    ]),
    ok: true,
    requestId: message.requestId,
  }));

  await environment.requestCandidates();
  assert.match(
    environment.elements["#candidate-status"].textContent,
    /1件の候補/u,
  );
  environment.chooseRenderedCandidate();
  environment.inputExplanation("文字列へ変換した値を返します。");
  await environment.submit().completion;

  const evaluationMessage = environment.evaluationMessages.find(
    (message) => message.type === "EVALUATE_ANSWER",
  );
  assert.equal(evaluationMessage.request.sourceUrl, sourceUrl);
  assert.equal(evaluationMessage.request.code, candidateCode);
  assert.equal(environment.elements["#total-score-value"].textContent, "82");
});

test("候補がない場合は別のPythonファイルで再試行できると案内する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  await environment.requestCandidates();

  assert.match(
    environment.elements["#candidate-status"].textContent,
    /候補が見つかりません/u,
  );
  assert.match(
    environment.elements["#candidate-status"].textContent,
    /別のpublic Pythonファイル/u,
  );
  assert.doesNotMatch(
    environment.elements["#candidate-status"].textContent,
    /トレーニング|コードを選択/u,
  );
  assert.equal(environment.elements["#candidate-section"].hidden, false);
});

test("ページ遷移を検知した時点で古い候補レスポンスを破棄する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  let finishCandidates;
  environment.setCandidatesHandler(
    (message) =>
      new Promise((resolve) => {
        finishCandidates = () =>
          resolve({
            candidates: [
              {
                code: "def stale(value):\n    result = value + 1\n    return result",
                difficulty: "初級",
                endLine: 3,
                estimatedMinutes: 5,
                id: "function:stale:1",
                kind: "function",
                level: "recommended",
                name: "stale",
                reason: "古い候補です。",
                sourceUrl: `https://github.com/example/project/blob/${"a".repeat(40)}/first.py`,
                startLine: 1,
              },
            ],
            contextKey: JSON.stringify([
              message.context.repository,
              message.context.commitOid,
              message.context.path,
            ]),
            ok: true,
            requestId: message.requestId,
          });
      }),
  );

  const pending = environment.requestCandidates();
  await flushPromises();
  environment.navigate({
    ...eligibleContext("second.py"),
    commitOid: "b".repeat(40),
    url: "https://github.com/example/project/blob/main/second.py",
  });
  finishCandidates();
  await pending;

  assert.equal(environment.elements["#candidate-list"].children.length, 0);
  assert.equal(environment.elements["#candidate-section"].hidden, true);
});

test("採点結果から新しいトレーニングを開始できる", () => {
  assert.match(sidepanelHtmlSource, /id="new-training-button"/u);
  assert.match(sidepanelHtmlSource, /新しいトレーニングを始める/u);
});

test("候補コードでトレーニングと読解サポートを切り替え、入力を分離する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");

  environment.chooseReadingMode();
  assert.equal(environment.elements["#training-input"].hidden, true);
  assert.equal(environment.elements["#reading-input"].hidden, false);
  environment.inputReadingQuestion("value の由来を確認したい");
  assert.equal(environment.elements["#reading-submit-button"].disabled, false);

  environment.chooseTrainingMode();
  assert.equal(environment.elements["#explanation"].value, "値を返します。");
  assert.equal(
    environment.elements["#reading-question"].value,
    "value の由来を確認したい",
  );
  assert.equal(environment.elements["#reading-result"].hidden, true);
});

test("最初は着眼点・確認事項・質問・ヒントを表示し詳しい説明は隠す", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("value の流れを理解したい");
  environment.requestReadingGuide();
  await flushPromises();

  assert.equal(environment.evaluationMessages.length, 1);
  assert.equal(
    environment.evaluationMessages[0].type,
    "REQUEST_READING_SUPPORT",
  );
  assert.equal(environment.evaluationMessages[0].request.code, "return value");
  assert.equal(environment.evaluationMessages[0].request.stage, "guide");
  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#reading-result"].hidden, false);
  assert.match(
    elementText(environment.elements["#focus-points-list"]),
    /value/u,
  );
  assert.match(elementText(environment.elements["#checks-list"]), /value/u);
  assert.match(
    elementText(environment.elements["#reading-questions-list"]),
    /value/u,
  );
  assert.match(elementText(environment.elements["#hints-list"]), /return/u);
  assert.equal(
    environment.elements["#detailed-explanation-block"].hidden,
    true,
  );
});

test("明示操作後だけ詳しい説明を追加取得して表示する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("value の流れを理解したい");
  environment.requestReadingGuide();
  await flushPromises();
  assert.equal(environment.evaluationMessages.length, 1);

  environment.requestDetail();
  await flushPromises();
  assert.equal(environment.evaluationMessages.length, 2);
  assert.equal(
    environment.evaluationMessages[1].request.stage,
    "detailed_explanation",
  );
  assert.equal(
    environment.elements["#detailed-explanation-block"].hidden,
    false,
  );
  assert.match(
    environment.elements["#detailed-explanation"].textContent,
    /value/u,
  );
});

test("読解サポートのAPIエラーでも質問を保持して再試行できる", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.chooseReadingMode();
  const question = "value の流れを理解したい";
  environment.inputReadingQuestion(question);
  let calls = 0;
  environment.setReadingHandler(async (message) => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        error: {
          code: "READING_SUPPORT_MODEL_ERROR",
          details: [],
          message: "ガイドを作成できませんでした。",
          retryable: true,
        },
      };
    }
    return {
      ok: true,
      response: readingSupportResponse(message.request.stage),
    };
  });
  environment.requestReadingGuide();
  await flushPromises();
  assert.equal(environment.elements["#reading-question"].value, question);
  assert.equal(environment.elements["#reading-submit-button"].disabled, false);
  assert.match(environment.elements["#status"].textContent, /保持/u);

  environment.requestReadingGuide();
  await flushPromises();
  assert.equal(calls, 2);
  assert.equal(environment.elements["#reading-result"].hidden, false);
});

test("読解エラーはモード切替と同一ページ更新後も理由を表示する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("value を確認したい");
  environment.setReadingHandler(async () => ({
    ok: false,
    error: {
      code: "UNAUTHORIZED",
      details: [],
      message: "このAPIを利用できません。",
      retryable: false,
    },
  }));
  environment.requestReadingGuide();
  await flushPromises();

  environment.chooseTrainingMode();
  environment.chooseReadingMode();
  assert.match(environment.elements["#status"].textContent, /利用できません/u);
  assert.equal(environment.elements["#reading-submit-button"].disabled, true);

  environment.notifyPageContextChanged();
  await flushPromises();
  assert.match(environment.elements["#status"].textContent, /利用できません/u);
});

test("詳しい説明の回数制限中は期限まで再試行ボタンを無効にする", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("value を確認したい");
  environment.requestReadingGuide();
  await flushPromises();
  environment.setReadingHandler(async () => ({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      details: [],
      message: "利用回数の上限に達しました。",
      retryable: true,
      retryAfterSeconds: 60,
    },
  }));

  environment.requestDetail();
  await flushPromises();
  assert.equal(environment.elements["#detail-button"].disabled, true);
  assert.match(environment.elements["#detail-button"].textContent, /待機中/u);
  environment.runTimers();
  assert.equal(environment.elements["#detail-button"].disabled, false);
  assert.match(
    environment.elements["#detail-button"].textContent,
    /もう一度取得/u,
  );
});

test("ページ遷移後に届いた読解の回数制限も新しい入力を期限まで止める", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return old_value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("old_value を確認したい");
  let finishReading;
  environment.setReadingHandler(
    () =>
      new Promise((resolve) => {
        finishReading = resolve;
      }),
  );
  environment.requestReadingGuide();
  await flushPromises();

  environment.navigate(eligibleContext("second.py"));
  await flushPromises();
  await environment.startWithCandidate("return new_value");
  environment.chooseReadingMode();
  environment.inputReadingQuestion("new_value を確認したい");
  assert.equal(environment.elements["#reading-submit-button"].disabled, false);

  finishReading({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      details: [],
      message: "利用回数の上限に達しました。",
      retryable: true,
      retryAfterSeconds: 60,
    },
  });
  await flushPromises();
  assert.equal(environment.elements["#reading-submit-button"].disabled, true);
  environment.runTimers();
  assert.equal(environment.elements["#reading-submit-button"].disabled, false);
});

test("読解サポートの計測イベントにコード・質問本文を保存しない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  const code = "return sensitive_code";
  const question = "sensitive_question を確認したい";
  await environment.startWithCandidate(code);
  environment.chooseReadingMode();
  environment.inputReadingQuestion(question);
  environment.requestReadingGuide();
  await flushPromises();
  environment.requestDetail();
  await flushPromises();
  await environment.completeReading();
  await flushPromises();

  const events = environment.storage.anonymousUsageEvents as Array<{
    name: string;
  }>;
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /sensitive_code/u);
  assert.doesNotMatch(serialized, /sensitive_question/u);
  assert.deepEqual(JSON.parse(JSON.stringify(events.map(({ name }) => name))), [
    "reading_support_started",
    "reading_support_guide_displayed",
    "reading_support_detail_displayed",
    "reading_support_completed",
  ]);
});

test("Pythonファイル間の遷移で前の対象コードと回答を消す", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  environment.elements["#training-session"].hidden = false;
  environment.elements["#selected-code"].textContent = "old code";
  environment.elements["#explanation"].value = "old answer";

  environment.navigate(eligibleContext("second.py"));
  await flushPromises();

  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#selected-code"].textContent, "");
  assert.equal(environment.elements["#explanation"].value, "");
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
});

test("対象外ページへの遷移ではおすすめ候補の操作を無効にする", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  environment.navigate({
    ...eligibleContext("README.md"),
    path: null,
    reason: "not-python",
    status: "unsupported",
  });
  await flushPromises();

  assert.equal(environment.elements["#recommendation-button"].disabled, true);
  assert.match(environment.elements["#status"].textContent, /Python/u);
});

test("候補コードと回答が揃った場合だけ評価操作を有効にする", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  await environment.startWithCandidate("def example():\n    return 1");
  assert.equal(environment.elements["#training-session"].hidden, false);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.match(environment.elements["#input-error"].textContent, /回答を入力/u);

  environment.inputExplanation("値1を返す関数です。");
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
  assert.equal(environment.elements["#input-error"].textContent, "");
  assert.equal(environment.elements["#explanation"]["aria-invalid"], "false");
  const submission = environment.submit();
  assert.equal(submission.defaultPrevented, true);
  await submission.completion;
  assert.match(environment.elements["#status"].textContent, /採点が完了/u);
});

test("回答の入力上限超過では修正方法を示して評価できない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  await environment.startWithCandidate("print('ok')");
  environment.inputExplanation("あ".repeat(5_001));
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(environment.elements["#explanation"]["aria-invalid"], "true");
  assert.match(environment.elements["#input-error"].textContent, /内容を短く/u);
});

test("外部入力をHTMLではなくテキストとして表示する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  const code = '<img src=x onerror="alert(1)">';
  const explanation = '<script>alert("xss")</script>';

  await environment.startWithCandidate(code);
  environment.inputExplanation(explanation);

  assert.equal(environment.elements["#selected-code"].textContent, code);
  assert.equal(environment.elements["#explanation"].value, explanation);
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
});

test("採点結果を表示し、対象外の評価軸を除外する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("def example():\n    return 1");
  environment.inputExplanation("値1を返す関数です。");

  const response = evaluationResponse(100);
  const purpose = response.criteria.find(({ id }) => id === "purpose");
  purpose.maxScore = 35;
  const excluded = response.criteria.find(({ id }) => id === "side_effects");
  excluded.applicable = false;
  excluded.exclusionReason = "副作用を持たないため対象外です。";
  excluded.feedback = null;
  excluded.maxScore = 0;
  excluded.score = null;
  response.totalScore = 90;
  response.strengths = [
    '<script>alert("strength")</script>',
    "戻り値を説明できています。",
  ];
  response.gaps = ["呼び出し条件の説明が不足しています。"];
  const mainFlow = response.criteria.find(({ id }) => id === "main_flow");
  mainFlow.feedback = '<img src=x onerror="alert(1)">';
  environment.setEvaluationHandler(async () => ({ ok: true, response }));

  await environment.submit().completion;

  assert.equal(environment.elements["#evaluation-result"].hidden, false);
  assert.equal(environment.elements["#total-score-value"].textContent, "90");
  assert.equal(environment.elements["#criteria-list"].children.length, 5);
  assert.doesNotMatch(
    elementText(environment.elements["#criteria-list"]),
    /副作用/u,
  );
  assert.match(
    elementText(environment.elements["#criteria-list"]),
    /<img src=x onerror="alert\(1\)">/u,
  );
  assert.equal(
    environment.elements["#strengths-list"].children[0].textContent,
    '<script>alert("strength")</script>',
  );
  assert.match(
    elementText(environment.elements["#gaps-list"]),
    /呼び出し条件の説明が不足/u,
  );
});

test("模範解答は採点成功後だけ自分の回答と並べて表示する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  const userAnswer = "valueを返します。";
  const modelAnswer = `${"長い模範解答です。".repeat(300)}\nvalueを返します。`;

  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#model-answer"].textContent, "");

  await environment.startWithCandidate("return value");
  environment.inputExplanation(userAnswer);
  const response = evaluationResponse();
  response.modelAnswer = modelAnswer;
  environment.setEvaluationHandler(async () => ({ ok: true, response }));

  await environment.submit().completion;

  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#training-methods"].hidden, true);
  assert.equal(environment.elements["#evaluation-result"].hidden, false);
  assert.equal(environment.elements["#user-answer"].textContent, userAnswer);
  assert.equal(environment.elements["#model-answer"].textContent, modelAnswer);
});

test("不正な採点結果を表示せず回答を保持して再試行できる", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  const answer = "値を返します。";
  environment.inputExplanation(answer);
  const invalidResponse = evaluationResponse();
  invalidResponse.totalScore = 101;
  environment.setEvaluationHandler(async () => ({
    ok: true,
    response: invalidResponse,
  }));

  await environment.submit().completion;

  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#explanation"].value, answer);
  assert.equal(environment.elements["#explanation"].readOnly, false);
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
  assert.match(
    environment.elements["#status"].textContent,
    /採点結果を正しく読み取れません/u,
  );
});

test("採点中は入力と送信を固定して二重送信を防ぐ", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("def example():\n    return 1");
  environment.inputExplanation("値1を返す関数です。");

  let finishEvaluation;
  environment.setEvaluationHandler(
    () =>
      new Promise((resolve) => {
        finishEvaluation = resolve;
      }),
  );

  const firstSubmission = environment.submit();
  const secondSubmission = environment.submit();

  assert.equal(environment.evaluationMessages.length, 1);
  assert.equal(environment.elements["#explanation"].readOnly, true);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(
    environment.elements["#evaluation-button"].textContent,
    "評価中…",
  );

  finishEvaluation({ ok: true, response: evaluationResponse() });
  await Promise.all([firstSubmission.completion, secondSubmission.completion]);
});

test("APIエラー時は回答を保持し、手動で再送信できる", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("print('hello')");
  const answer = "helloと表示します。";
  environment.inputExplanation(answer);
  environment.setEvaluationHandler(async () => ({
    ok: false,
    error: {
      code: "MODEL_ERROR",
      details: [
        {
          field: "explanation",
          reason: "回答の内容を確認してください。",
        },
      ],
      message: "モデルでエラーが発生しました。",
      retryable: true,
    },
  }));

  await environment.submit().completion;

  assert.equal(environment.elements["#explanation"].value, answer);
  assert.equal(environment.elements["#explanation"].readOnly, false);
  assert.equal(environment.elements["#training-methods"].hidden, false);
  assert.equal(environment.elements["#explanation"]["aria-invalid"], "true");
  assert.match(
    environment.elements["#input-error"].textContent,
    /explanation: 回答の内容を確認/u,
  );
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
  assert.equal(
    environment.elements["#evaluation-button"].textContent,
    "もう一度評価する",
  );
  assert.match(environment.elements["#status"].textContent, /モデルでエラー/u);

  await environment.submit().completion;
  assert.equal(environment.evaluationMessages.length, 2);
});

test("回数制限の待機中は回答を編集しても期限まで再送信できない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("print('hello')");
  environment.inputExplanation("helloと表示します。");
  environment.setEvaluationHandler(async () => ({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      details: [],
      message: "利用回数の上限に達しました。",
      retryable: true,
      retryAfterSeconds: 60,
    },
  }));

  await environment.submit().completion;
  assert.equal(environment.elements["#evaluation-button"].disabled, true);

  environment.inputExplanation("helloを1回表示します。");
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(environment.evaluationMessages.length, 1);

  environment.runTimers();
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
});

test("回数制限の待機はコードを再選択しても解除されない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("print('first')");
  environment.inputExplanation("firstと表示します。");
  environment.setEvaluationHandler(async () => ({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      details: [],
      message: "利用回数の上限に達しました。",
      retryable: true,
      retryAfterSeconds: 60,
    },
  }));
  await environment.submit().completion;

  await environment.startWithCandidate("print('second')");
  environment.inputExplanation("secondと表示します。");
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(environment.evaluationMessages.length, 1);

  environment.runTimers();
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
});

test("設定済み評価APIの正確なOriginを許可した後だけ送信する", async () => {
  const permissionOrigin =
    "https://code-reading-trainer-evaluation-api.account.workers.dev/*";
  const environment = createSidepanelEnvironment({ permissionOrigin });
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");

  await environment.submit().completion;

  assert.deepEqual(JSON.parse(JSON.stringify(environment.permissionRequests)), [
    { origins: [permissionOrigin] },
  ]);
  assert.equal(environment.evaluationMessages.length, 1);
});

test("評価APIへの接続許可を拒否しても回答を保持し再試行できる", async () => {
  const answer = "値を返します。";
  const environment = createSidepanelEnvironment({
    permissionGranted: false,
    permissionOrigin:
      "https://code-reading-trainer-evaluation-api.account.workers.dev/*",
  });
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation(answer);

  await environment.submit().completion;

  assert.equal(environment.evaluationMessages.length, 0);
  assert.equal(environment.elements["#explanation"].value, answer);
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
  assert.match(environment.elements["#status"].textContent, /許可されません/u);
});

test("採点成功後は回答を固定して同じ回答を再送信できない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");

  await environment.submit().completion;
  const secondSubmission = environment.submit();
  await secondSubmission.completion;

  assert.equal(environment.evaluationMessages.length, 1);
  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#explanation"].readOnly, true);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(
    environment.elements["#evaluation-button"].textContent,
    "評価済み",
  );
  assert.match(environment.elements["#status"].textContent, /82 \/ 100点/u);
});

test("新しいトレーニングでは前のセッションを一度だけ消してページ情報を再取得する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return first_value");
  environment.inputExplanation("最初の値を返します。");
  const firstResponse = evaluationResponse();
  firstResponse.strengths = ["戻り値を説明できています。"];
  firstResponse.gaps = ["前提の説明が不足しています。"];
  firstResponse.modelAnswer = "最初の模範解答です。";
  environment.setEvaluationHandler(async () => ({
    ok: true,
    response: firstResponse,
  }));
  await environment.submit().completion;

  const requestsBeforeReset = environment.getPageContextRequestCount();
  const resetSelectors = ["#criteria-list", "#strengths-list", "#gaps-list"];
  const replaceCountsBeforeReset = resetSelectors.map((selector) =>
    environment.getReplaceChildrenCount(selector),
  );
  await Promise.all([
    environment.startNewTraining(),
    environment.startNewTraining(),
  ]);

  assert.equal(
    environment.getPageContextRequestCount(),
    requestsBeforeReset + 1,
  );
  for (const [index, selector] of resetSelectors.entries()) {
    assert.equal(
      environment.getReplaceChildrenCount(selector),
      replaceCountsBeforeReset[index] + 1,
    );
  }
  assert.equal(environment.elements["#training-methods"].hidden, false);
  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#selected-code"].textContent, "");
  assert.equal(environment.elements["#explanation"].value, "");
  assert.equal(environment.elements["#input-error"].textContent, "");
  assert.equal(environment.elements["#total-score-value"].textContent, "");
  assert.equal(environment.elements["#criteria-list"].children.length, 0);
  assert.equal(environment.elements["#strengths-list"].children.length, 0);
  assert.equal(environment.elements["#gaps-list"].children.length, 0);
  assert.equal(environment.elements["#user-answer"].textContent, "");
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.match(environment.elements["#status"].textContent, /first\.py/u);

  await environment.submit().completion;
  assert.equal(environment.evaluationMessages.length, 1);

  await environment.startWithCandidate("return second_value");
  environment.inputExplanation("次の値を返します。");
  environment.setEvaluationHandler(async () => ({
    ok: true,
    response: evaluationResponse(90),
  }));
  await environment.submit().completion;

  assert.equal(environment.evaluationMessages.length, 2);
  assert.equal(
    environment.evaluationMessages[1].request.code,
    "return second_value",
  );
  assert.equal(
    environment.evaluationMessages[1].request.explanation,
    "次の値を返します。",
  );
});

test("新しいトレーニングのページ再取得に失敗しても前の結果を残さない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");
  const response = evaluationResponse();
  response.modelAnswer = "前の模範解答です。";
  environment.setEvaluationHandler(async () => ({ ok: true, response }));
  await environment.submit().completion;
  environment.setPageContextHandler(async () => {
    throw new Error("page context failed");
  });

  await environment.startNewTraining();

  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#selected-code"].textContent, "");
  assert.equal(environment.elements["#explanation"].value, "");
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.equal(environment.elements["#recommendation-button"].disabled, true);
  assert.match(environment.elements["#status"].textContent, /取得できません/u);
});

test("新しいトレーニングの再取得先が対象外なら選択を無効にして案内する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");
  await environment.submit().completion;
  environment.setPageContextHandler(async () => ({
    ...eligibleContext("README.md"),
    path: null,
    reason: "not-python",
    status: "unsupported",
  }));

  await environment.startNewTraining();

  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.equal(environment.elements["#recommendation-button"].disabled, true);
  assert.match(environment.elements["#status"].textContent, /Python/u);
});

test("採点中にページが変わった場合は古い結果で新しい画面を更新しない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return old_value");
  environment.inputExplanation("古い値を返します。");

  let finishEvaluation;
  environment.setEvaluationHandler(
    () =>
      new Promise((resolve) => {
        finishEvaluation = resolve;
      }),
  );
  const submission = environment.submit();

  environment.navigate(eligibleContext("second.py"));
  await flushPromises();
  finishEvaluation({ ok: true, response: evaluationResponse(99) });
  await submission.completion;

  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#explanation"].value, "");
  assert.equal(environment.elements["#explanation"].readOnly, false);
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
  assert.doesNotMatch(environment.elements["#status"].textContent, /99/u);
});

test("ページ遷移後に届いた回数制限も新しい回答の送信を期限まで止める", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return old_value");
  environment.inputExplanation("古い値を返します。");

  let finishEvaluation;
  environment.setEvaluationHandler(
    () =>
      new Promise((resolve) => {
        finishEvaluation = resolve;
      }),
  );
  const submission = environment.submit();
  environment.navigate(eligibleContext("second.py"));
  await flushPromises();
  await environment.startWithCandidate("return new_value");
  environment.inputExplanation("新しい値を返します。");
  assert.equal(environment.elements["#evaluation-button"].disabled, false);

  finishEvaluation({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      details: [],
      message: "利用回数の上限に達しました。",
      retryable: true,
      retryAfterSeconds: 60,
    },
  });
  await submission.completion;

  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  await environment.submit().completion;
  assert.equal(environment.evaluationMessages.length, 1);

  environment.runTimers();
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
});

test("採点完了後に別ファイルへ移動すると新しい選択を開始できる", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return first");
  environment.inputExplanation("最初の値を返します。");
  await environment.submit().completion;

  environment.navigate(eligibleContext("second.py"));
  await flushPromises();

  assert.equal(environment.elements["#training-session"].hidden, true);
  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
});

test("採点完了後のタブ切り替えでは移動先に合わせて前の結果を消す", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return first");
  environment.inputExplanation("最初の値を返します。");
  await environment.submit().completion;

  environment.activateTab(eligibleContext("second.py"));
  await flushPromises();

  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#explanation"].value, "");
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
});

test("同じページの再確認で採点中・完了状態の表示を上書きしない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.startWithCandidate("return value");
  environment.inputExplanation("値を返します。");

  let finishEvaluation;
  environment.setEvaluationHandler(
    () =>
      new Promise((resolve) => {
        finishEvaluation = resolve;
      }),
  );
  const submission = environment.submit();
  environment.navigate(eligibleContext("first.py"));
  await flushPromises();
  assert.match(environment.elements["#status"].textContent, /評価しています/u);

  finishEvaluation({ ok: true, response: evaluationResponse(91) });
  await submission.completion;
  environment.navigate(eligibleContext("first.py"));
  await flushPromises();
  assert.match(environment.elements["#status"].textContent, /91 \/ 100点/u);
});

test("古いページ情報の応答が後着しても新しいページ状態を上書きしない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  const resolvers = [];
  environment.setPageContextHandler(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );

  environment.notifyPageContextChanged();
  environment.notifyPageContextChanged();
  await flushPromises();
  resolvers[1](eligibleContext("new.py"));
  await flushPromises();
  resolvers[0](eligibleContext("old.py"));
  await flushPromises();

  assert.match(environment.elements["#status"].textContent, /new\.py/u);
  assert.doesNotMatch(environment.elements["#status"].textContent, /old\.py/u);
});

test("古い候補要求の失敗が新しいページ状態を上書きしない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  let rejectOldRequest;
  let requestCount = 0;
  environment.setPageContextHandler(() => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Promise((_resolve, reject) => {
        rejectOldRequest = reject;
      });
    }
    return Promise.resolve(eligibleContext("new.py"));
  });

  const oldCandidateRequest = environment.requestCandidates();
  environment.notifyPageContextChanged();
  await flushPromises();
  rejectOldRequest(new Error("old request failed"));
  await oldCandidateRequest;

  assert.match(environment.elements["#status"].textContent, /new\.py/u);
  assert.doesNotMatch(
    environment.elements["#status"].textContent,
    /取得できません/u,
  );
});
