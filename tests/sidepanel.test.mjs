import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const sidepanelSource = await readFile(
  path.join(process.cwd(), "src/sidepanel.js"),
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
  const elements = {
    "#status": { textContent: "" },
    "#selection-button": {
      disabled: false,
      addEventListener() {},
    },
    "#selection": { hidden: true },
    "#selected-code": { textContent: "" },
    "#explanation": { value: "" },
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

  vm.runInContext(sidepanelSource, context);

  return {
    elements,
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
