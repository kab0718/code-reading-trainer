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
const sidepanelHtmlSource = await readFile(
  path.join(process.cwd(), "src/sidepanel.html"),
  "utf8",
);

function eligibleContext(filePath) {
  return {
    status: "eligible",
    reason: null,
    url: `https://github.com/example/project/blob/main/${filePath}`,
    repository: "example/project",
    ref: "main",
    path: filePath,
    selectedText: "",
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

function createSidepanelEnvironment({
  permissionGranted = true,
  permissionOrigin = null,
} = {}) {
  let currentContext = eligibleContext("first.py");
  let pageContextHandler = async () => currentContext;
  let runtimeListener;
  let evaluationHandler = async () => ({
    ok: true,
    response: evaluationResponse(),
  });
  const evaluationMessages = [];
  const permissionRequests = [];
  const timers = new Map();
  let nextTimerId = 1;
  const listeners = new Map();
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
    "#selection-button": createElement("#selection-button", {
      disabled: false,
    }),
    "#selection": createElement("#selection", { hidden: true }),
    "#selected-code": createElement("#selected-code", { textContent: "" }),
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
      runtime: {
        async sendMessage(message) {
          evaluationMessages.push(message);
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
          return pageContextHandler();
        },
        onActivated: { addListener() {} },
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
  if (permissionOrigin !== null) {
    context.CodeReadingTrainerEvaluationConfig = Object.freeze({
      getEvaluationApiPermissionOrigin: () => permissionOrigin,
      getEvaluationApiUrl: () => null,
    });
  }
  vm.runInContext(sidepanelSource, context);

  return {
    elements,
    async select(selectedText) {
      currentContext = { ...currentContext, selectedText };
      await listeners.get("#selection-button:click")();
    },
    inputExplanation(value) {
      elements["#explanation"].value = value;
      listeners.get("#explanation:input")();
    },
    submit() {
      let defaultPrevented = false;
      const completion = listeners.get("#selection:submit")({
        preventDefault() {
          defaultPrevented = true;
        },
      });
      return { completion, defaultPrevented };
    },
    evaluationMessages,
    permissionRequests,
    setEvaluationHandler(handler) {
      evaluationHandler = handler;
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    navigate(pageContext) {
      currentContext = pageContext;
      runtimeListener({ type: "PAGE_CONTEXT_CHANGED" });
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

test("Pythonファイル間の遷移で前の選択コードと回答を消す", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  environment.elements["#selection"].hidden = false;
  environment.elements["#selected-code"].textContent = "old code";
  environment.elements["#explanation"].value = "old answer";

  environment.navigate(eligibleContext("second.py"));
  await flushPromises();

  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#selected-code"].textContent, "");
  assert.equal(environment.elements["#explanation"].value, "");
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
});

test("選択コードと回答が揃った場合だけ評価操作を有効にする", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  await environment.select("def example():\n    return 1");
  assert.equal(environment.elements["#selection"].hidden, false);
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

test("未選択と入力上限超過では修正方法を示して評価できない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();

  await environment.select("   ");
  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.match(environment.elements["#status"].textContent, /コードを選択/u);

  await environment.select("x".repeat(30_001));
  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.match(environment.elements["#status"].textContent, /選択範囲を短く/u);

  await environment.select("print('ok')");
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

  await environment.select(code);
  environment.inputExplanation(explanation);

  assert.equal(environment.elements["#selected-code"].textContent, code);
  assert.equal(environment.elements["#explanation"].value, explanation);
  assert.equal(environment.elements["#evaluation-button"].disabled, false);
});

test("採点結果を表示し、対象外の評価軸を除外する", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.select("def example():\n    return 1");
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

  await environment.select("return value");
  environment.inputExplanation(userAnswer);
  const response = evaluationResponse();
  response.modelAnswer = modelAnswer;
  environment.setEvaluationHandler(async () => ({ ok: true, response }));

  await environment.submit().completion;

  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#training-methods"].hidden, true);
  assert.equal(environment.elements["#evaluation-result"].hidden, false);
  assert.equal(environment.elements["#user-answer"].textContent, userAnswer);
  assert.equal(environment.elements["#model-answer"].textContent, modelAnswer);
});

test("不正な採点結果を表示せず回答を保持して再試行できる", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.select("return value");
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
  await environment.select("def example():\n    return 1");
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
  await environment.select("print('hello')");
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
  assert.equal(environment.elements["#selection-button"].disabled, false);
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
  await environment.select("print('hello')");
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
  await environment.select("print('first')");
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

  await environment.select("print('second')");
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
  await environment.select("return value");
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
  await environment.select("return value");
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
  await environment.select("return value");
  environment.inputExplanation("値を返します。");

  await environment.submit().completion;
  const secondSubmission = environment.submit();
  await secondSubmission.completion;

  assert.equal(environment.evaluationMessages.length, 1);
  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#explanation"].readOnly, true);
  assert.equal(environment.elements["#evaluation-button"].disabled, true);
  assert.equal(
    environment.elements["#evaluation-button"].textContent,
    "評価済み",
  );
  assert.match(environment.elements["#status"].textContent, /82 \/ 100点/u);
});

test("採点中にページが変わった場合は古い結果で新しい画面を更新しない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.select("return old_value");
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

  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#explanation"].value, "");
  assert.equal(environment.elements["#explanation"].readOnly, false);
  assert.equal(environment.elements["#selection-button"].disabled, false);
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
  assert.doesNotMatch(environment.elements["#status"].textContent, /99/u);
});

test("ページ遷移後に届いた回数制限も新しい回答の送信を期限まで止める", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.select("return old_value");
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
  await environment.select("return new_value");
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
  await environment.select("return first");
  environment.inputExplanation("最初の値を返します。");
  await environment.submit().completion;

  assert.equal(environment.elements["#selection-button"].disabled, true);
  environment.navigate(eligibleContext("second.py"));
  await flushPromises();

  assert.equal(environment.elements["#selection-button"].disabled, false);
  assert.equal(environment.elements["#selection"].hidden, true);
  assert.equal(environment.elements["#evaluation-result"].hidden, true);
  assert.equal(environment.elements["#model-answer"].textContent, "");
  assert.match(environment.elements["#status"].textContent, /second\.py/u);
});

test("同じページの再確認で採点中・完了状態の表示を上書きしない", async () => {
  const environment = createSidepanelEnvironment();
  await flushPromises();
  await environment.select("return value");
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

test("古い選択要求の失敗が新しいページ状態を上書きしない", async () => {
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

  const oldSelection = environment.select("old code");
  environment.notifyPageContextChanged();
  await flushPromises();
  rejectOldRequest(new Error("old request failed"));
  await oldSelection;

  assert.match(environment.elements["#status"].textContent, /new\.py/u);
  assert.doesNotMatch(
    environment.elements["#status"].textContent,
    /取得できません/u,
  );
});
