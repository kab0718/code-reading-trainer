import assert from "node:assert/strict";
import { after, test } from "node:test";

import "../src/page-context.ts";

const { PAGE_STATUS, UNSUPPORTED_REASON, analyzeGitHubPage } =
  globalThis.CodeReadingTrainerPageContext;

after(() => {
  delete globalThis.CodeReadingTrainerPageContext;
});

function publicPage(overrides = {}) {
  return {
    url: "https://github.com/python/cpython/blob/main/Lib/abc.py",
    repositoryNwo: "python/cpython",
    repositoryPublic: "true",
    embeddedData: embeddedPage(),
    ...overrides,
  };
}

function embeddedPage({
  owner = "python",
  repository = "cpython",
  isPublic = true,
  ref = "main",
  filePath = "Lib/abc.py",
} = {}) {
  return {
    payload: {
      codeViewBlobLayoutRoute: {
        path: filePath,
        refInfo: { name: ref },
      },
      codeViewLayoutRoute: {
        repo: {
          ownerLogin: owner,
          name: repository,
          public: isPublic,
        },
      },
    },
  };
}

test("public repositoryのPython blobページを対象にする", () => {
  assert.deepEqual(analyzeGitHubPage(publicPage()), {
    status: PAGE_STATUS.ELIGIBLE,
    reason: null,
    url: "https://github.com/python/cpython/blob/main/Lib/abc.py",
    repository: "python/cpython",
    ref: "main",
    path: "Lib/abc.py",
  });
});

test("repository直下のPythonファイルを対象にする", () => {
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/example/project/blob/main/app.py",
      repositoryNwo: "example/project",
      embeddedData: embeddedPage({
        owner: "example",
        repository: "project",
        filePath: "app.py",
      }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.ELIGIBLE);
  assert.equal(result.path, "app.py");
});

test("スラッシュを含むrefを埋め込みページ情報から抽出する", () => {
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/example/project/blob/feature/parser/src/main.py?plain=1#L10",
      repositoryNwo: "example/project",
      embeddedData: embeddedPage({
        owner: "example",
        repository: "project",
        ref: "feature/parser",
        filePath: "src/main.py",
      }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.ELIGIBLE);
  assert.equal(result.ref, "feature/parser");
  assert.equal(result.path, "src/main.py");
});

test("埋め込み情報がない場合はref/pathを推測しない", () => {
  const result = analyzeGitHubPage(publicPage({ embeddedData: undefined }));

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("metaに公開状態がなければ埋め込み情報だけで対象化しない", () => {
  const result = analyzeGitHubPage(publicPage({ repositoryPublic: undefined }));

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.VISIBILITY_UNKNOWN);
});

test("Python以外のblobページを対象外にする", () => {
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/python/cpython/blob/main/README.rst",
      embeddedData: embeddedPage({ filePath: "README.rst" }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.NOT_PYTHON);
});

test("treeページをrepositoryトップとして扱わない", () => {
  const result = analyzeGitHubPage(
    publicPage({ url: "https://github.com/python/cpython/tree/main/Lib" }),
  );
  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.NOT_CODE_VIEW);
});

test("public repositoryトップをcommit固定の対象ページとして認識する", () => {
  const commitOid = "b".repeat(40);
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/python/cpython",
      embeddedData: {
        payload: {
          codeViewRepoRoute: {
            path: "/",
            refInfo: { name: "main", currentOid: commitOid },
          },
          codeViewLayoutRoute: {
            repo: {
              ownerLogin: "python",
              name: "cpython",
              public: true,
            },
            refInfo: { name: "main", currentOid: commitOid },
            path: "/",
          },
        },
      },
    }),
  );

  assert.deepEqual(result, {
    commitOid,
    status: PAGE_STATUS.REPOSITORY,
    reason: null,
    url: "https://github.com/python/cpython",
    repository: "python/cpython",
    ref: "main",
    path: null,
  });
});

test("repositoryトップはcommit OIDを確認できなければ対象化しない", () => {
  const result = analyzeGitHubPage(
    publicPage({ url: "https://github.com/python/cpython" }),
  );
  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("GitHub以外のページを対象外にする", () => {
  const result = analyzeGitHubPage(
    publicPage({ url: "https://example.com/python/cpython/blob/main/app.py" }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.NOT_GITHUB);
});

test("private repositoryを対象外にする", () => {
  const result = analyzeGitHubPage(
    publicPage({
      repositoryPublic: "false",
      embeddedData: embeddedPage({ isPublic: false }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PRIVATE_REPOSITORY);
});

test("公開状態の情報源が矛盾する場合は対象外にする", () => {
  const result = analyzeGitHubPage(
    publicPage({
      embeddedData: embeddedPage({ isPublic: false }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("埋め込み情報が別repositoryのものなら対象外にする", () => {
  const result = analyzeGitHubPage(
    publicPage({
      embeddedData: embeddedPage({
        owner: "another",
        repository: "repository",
      }),
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("存在を確認できないblob形式URLをコード画面として扱わない", () => {
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/python/cpython/blob/main/does-not-exist.py",
      embeddedData: undefined,
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("公開状態を確認できないrepositoryを安全側で対象外にする", () => {
  const result = analyzeGitHubPage(publicPage({ repositoryPublic: undefined }));

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.VISIBILITY_UNKNOWN);
});

test("埋め込み情報にrepository identityがなければ対象化しない", () => {
  const result = analyzeGitHubPage(
    publicPage({
      embeddedData: {
        payload: {
          codeViewBlobLayoutRoute: {
            path: "Lib/abc.py",
            refInfo: { name: "main" },
          },
        },
      },
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("metaにrepository identityがなければ対象化しない", () => {
  const result = analyzeGitHubPage(publicPage({ repositoryNwo: undefined }));

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("SPA遷移中の古いrepository情報を使用しない", () => {
  const result = analyzeGitHubPage(
    publicPage({ repositoryNwo: "another/repository" }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});

test("URLと埋め込み情報が一致しない間は古いref/pathを返さない", () => {
  const result = analyzeGitHubPage(
    publicPage({
      url: "https://github.com/python/cpython/blob/main/Lib/ast.py",
    }),
  );

  assert.equal(result.status, PAGE_STATUS.UNSUPPORTED);
  assert.equal(result.reason, UNSUPPORTED_REASON.PAGE_DATA_UNAVAILABLE);
});
