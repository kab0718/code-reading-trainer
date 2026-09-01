import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const projectRoot = process.cwd();
const pageContextSource = await readFile(
  path.join(projectRoot, "dist/extension/src/page-context.js"),
  "utf8",
);
const contentSource = await readFile(
  path.join(projectRoot, "dist/extension/src/content.js"),
  "utf8",
);

function embeddedData(ref, filePath, commitOid = undefined) {
  return JSON.stringify({
    payload: {
      codeViewBlobLayoutRoute: {
        ...(commitOid ? { commitOid } : {}),
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

type ContentEnvironmentOptions = {
  embeddedAppName?: string;
  embeddedDataByAppName?: Record<string, string>;
};

function createContentEnvironment({
  embeddedAppName = "code-view",
  embeddedDataByAppName,
}: ContentEnvironmentOptions = {}) {
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
        const embeddedDataEntries = embeddedDataByAppName
          ? Object.entries(embeddedDataByAppName)
          : [[embeddedAppName, currentEmbeddedData]];
        for (const [appName, appEmbeddedData] of embeddedDataEntries) {
          if (selector.includes(`react-app[app-name="${appName}"]`)) {
            return { textContent: appEmbeddedData };
          }
        }
        return null;
      },
      querySelectorAll(selector) {
        if (!selector.includes("react-app.embeddedData")) return [];
        const embeddedDataEntries = embeddedDataByAppName
          ? Object.entries(embeddedDataByAppName)
          : [[embeddedAppName, currentEmbeddedData]];
        return embeddedDataEntries.map(([, textContent]) => ({ textContent }));
      },
    },
    window: {
      location,
      addEventListener() {},
      clearTimeout() {},
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
    setEmbeddedData(ref, filePath, commitOid = undefined) {
      currentEmbeddedData = embeddedData(ref, filePath, commitOid);
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

test("GET_PAGE_CONTEXTで対象ページのコンテキストを返す", () => {
  const environment = createContentEnvironment();

  assert.deepEqual(normalize(environment.getContext()), {
    status: "eligible",
    reason: null,
    url: "https://github.com/python/cpython/blob/main/Lib/abc.py",
    repository: "python/cpython",
    ref: "main",
    path: "Lib/abc.py",
    title: "abc.py at main · python/cpython",
  });
});

test("現在形式のcode-viewから埋め込みデータを取得する", () => {
  const environment = createContentEnvironment({
    embeddedAppName: "code-view",
  });

  assert.equal(environment.getContext().status, "eligible");
  assert.equal(environment.getContext().path, "Lib/abc.py");
});

test("従来形式のreact-code-viewから埋め込みデータを取得する", () => {
  const environment = createContentEnvironment({
    embeddedAppName: "react-code-view",
  });

  assert.equal(environment.getContext().status, "eligible");
  assert.equal(environment.getContext().path, "Lib/abc.py");
});

test("新旧形式が共存する場合はDOM順によらずcode-viewを優先する", () => {
  const environment = createContentEnvironment({
    embeddedDataByAppName: {
      "react-code-view": embeddedData("old", "Lib/old.py"),
      "code-view": embeddedData("main", "Lib/abc.py"),
    },
  });

  assert.equal(environment.getContext().status, "eligible");
  assert.equal(environment.getContext().ref, "main");
  assert.equal(environment.getContext().path, "Lib/abc.py");
});

test("code-viewのJSONが不正な場合は従来形式へフォールバックする", () => {
  const environment = createContentEnvironment({
    embeddedDataByAppName: {
      "code-view": "{invalid-json",
      "react-code-view": embeddedData("main", "Lib/abc.py"),
    },
  });

  assert.equal(environment.getContext().status, "eligible");
  assert.equal(environment.getContext().path, "Lib/abc.py");
});

test("未知のapp-nameでもrepository情報を持つ埋め込みデータを利用する", () => {
  const environment = createContentEnvironment({ embeddedAppName: "unknown" });

  assert.equal(environment.getContext().status, "eligible");
  assert.equal(environment.getContext().path, "Lib/abc.py");
});

test("表示中blobのcommit OIDをページ情報へ含める", () => {
  const environment = createContentEnvironment();
  const commitOid = "c".repeat(40);
  environment.setEmbeddedData("main", "Lib/abc.py", commitOid);

  assert.equal(environment.getContext().commitOid, commitOid);
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
