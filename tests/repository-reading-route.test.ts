import assert from "node:assert/strict";
import { test } from "node:test";

import { selectRepositoryReadingRoute } from "../src/repository-reading-route.ts";

const oid = "a".repeat(40);

test("実在する代表ファイルを概要からテストの順に最大5件選ぶ", () => {
  const candidates = selectRepositoryReadingRoute(
    [
      { path: "README.md", type: "blob" },
      { path: "pyproject.toml", type: "blob" },
      { path: "src/sample/cli.py", type: "blob" },
      { path: "src/sample/service.py", type: "blob" },
      { path: "src/sample/other.py", type: "blob" },
      { path: "tests/test_service.py", type: "blob" },
    ],
    "example/project",
    oid,
  );

  assert.deepEqual(
    candidates.map(({ category, path }) => ({ category, path })),
    [
      { category: "overview", path: "README.md" },
      { category: "configuration", path: "pyproject.toml" },
      { category: "entrypoint", path: "src/sample/cli.py" },
      { category: "core", path: "src/sample/other.py" },
      { category: "test", path: "tests/test_service.py" },
    ],
  );
  assert.ok(candidates.every((candidate) => candidate.reason.length > 0));
  assert.ok(candidates.every((candidate) => candidate.url.includes(oid)));
});

test("不足する分類を補わず見つかった候補だけを返す", () => {
  const candidates = selectRepositoryReadingRoute(
    [{ path: "main.py", type: "blob" }],
    "example/project",
    oid,
  );

  assert.deepEqual(
    candidates.map(({ category, path }) => ({ category, path })),
    [{ category: "entrypoint", path: "main.py" }],
  );
});

test("ディレクトリと重複パスを候補として水増ししない", () => {
  const candidates = selectRepositoryReadingRoute(
    [
      { path: "README.md", type: "tree" },
      { path: "README.md", type: "blob" },
      { path: "README.md", type: "blob" },
    ],
    "example/project",
    oid,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.path, "README.md");
});
