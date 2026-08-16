import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const projectRoot = process.cwd();
const pageContextSource = await readFile(
  path.join(projectRoot, "src/page-context.js"),
  "utf8",
);
const contentSource = await readFile(
  path.join(projectRoot, "src/content.js"),
  "utf8",
);

function embeddedData(ref, filePath) {
  return JSON.stringify({
    payload: {
      codeViewBlobLayoutRoute: {
        path: filePath,
        refInfo: { name: ref },
      },
      codeViewLayoutRoute: {
        repo: {
          ownerLogin: "python",
          name: "cpython",
          public: true,
        },
      },
    },
  });
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function createContentEnvironment() {
  let messageListener;
  let observerCallback;
  let currentEmbeddedData = embeddedData("main", "Lib/abc.py");
  const timers = [];
  const sentMessages = [];

  const location = {
    href: "https://github.com/python/cpython/blob/main/Lib/abc.py",
  };

  const context = vm.createContext({
    URL,
    console,
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage(message) {
          sentMessages.push(message);
          return Promise.resolve();
        },
      },
    },
    document: {
      title: "abc.py at main · python/cpython",
      documentElement: {},
      addEventListener() {},
      querySelector(selector) {
        if (selector.includes("repository_nwo")) {
          return { content: "python/cpython" };
        }
        if (selector.includes("repository_public")) {
          return { content: "true" };
        }
        if (selector.includes("react-app")) {
          return { textContent: currentEmbeddedData };
        }
        return null;
      },
    },
    window: {
      location,
      addEventListener() {},
      clearTimeout() {},
      getSelection() {
        return { toString: () => "def example():\n    pass" };
      },
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}
    },
  });

  vm.runInContext(pageContextSource, context);
  vm.runInContext(contentSource, context);

  return {
    getContext() {
      let response;
      messageListener({ type: "GET_PAGE_CONTEXT" }, {}, (value) => {
        response = value;
      });
      return response;
    },
    navigate(url, ref, filePath) {
      location.href = url;
      currentEmbeddedData = embeddedData(ref, filePath);
      observerCallback();
    },
    setEmbeddedData(ref, filePath) {
      currentEmbeddedData = embeddedData(ref, filePath);
      observerCallback();
    },
    runNextTimer() {
      const callback = timers.shift();
      assert.ok(callback, "実行待ちのタイマーがあること");
      callback();
    },
    sentMessages,
  };
}

test("GET_PAGE_CONTEXTで対象ページと選択コードを返す", () => {
  const environment = createContentEnvironment();

  assert.deepEqual(normalize(environment.getContext()), {
    status: "eligible",
    reason: null,
    url: "https://github.com/python/cpython/blob/main/Lib/abc.py",
    repository: "python/cpython",
    ref: "main",
    path: "Lib/abc.py",
    title: "abc.py at main · python/cpython",
    selectedText: "def example():\n    pass",
  });
});

test("SPA遷移では一時状態の後も同じURLを再判定する", () => {
  const environment = createContentEnvironment();
  const nextUrl =
    "https://github.com/python/cpython/blob/feature/parser/Lib/ast.py";

  environment.navigate(nextUrl, "main", "Lib/abc.py");
  environment.runNextTimer();
  assert.deepEqual(normalize(environment.sentMessages), [
    { type: "PAGE_CONTEXT_CHANGED" },
  ]);

  environment.setEmbeddedData("feature/parser", "Lib/ast.py");
  environment.runNextTimer();

  assert.deepEqual(normalize(environment.sentMessages), [
    { type: "PAGE_CONTEXT_CHANGED" },
    { type: "PAGE_CONTEXT_CHANGED" },
  ]);
  assert.equal(environment.getContext().ref, "feature/parser");
  assert.equal(environment.getContext().path, "Lib/ast.py");
});
