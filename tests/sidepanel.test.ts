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

function createSidepanelEnvironment() {
  let currentContext = eligibleContext("first.py");
  let runtimeListener;
  const listeners = new Map();
  interface MockElement {
    [key: string]: unknown;
    disabled?: boolean;
    hidden?: boolean;
    textContent?: string;
    value?: string;
    addEventListener(type: string, listener: unknown): void;
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
    setAttribute(name, value) {
      this[name] = value;
    },
  });
  const elements: Record<string, MockElement> = {
    "#status": createElement("#status", { textContent: "" }),
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
  };

  const context = vm.createContext({
    Error,
    JSON,
    chrome: {
      runtime: {
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
          return currentContext;
        },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    },
    document: {
      querySelector(selector) {
        return elements[selector];
      },
    },
  });

  vm.runInContext(inputValidationSource, context);
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
      listeners.get("#selection:submit")({
        preventDefault() {
          defaultPrevented = true;
        },
      });
      return defaultPrevented;
    },
    navigate(pageContext) {
      currentContext = pageContext;
      runtimeListener({ type: "PAGE_CONTEXT_CHANGED" });
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

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
  assert.equal(environment.submit(), true);
  assert.match(environment.elements["#status"].textContent, /入力内容を確認/u);
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
