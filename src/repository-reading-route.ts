export interface RepositoryTreeEntry {
  path: string;
  type: "blob" | "tree";
}

const CATEGORY_DETAILS: Record<RepositoryReadingCategory, { reason: string }> =
  {
    overview: {
      reason: "プロジェクトの目的、使い方、全体像を最初に確認するためです。",
    },
    configuration: {
      reason: "パッケージ構成、依存関係、実行方法を把握するためです。",
    },
    entrypoint: {
      reason: "プログラムがどこから動き始めるかを追うためです。",
    },
    core: {
      reason: "プロジェクトの中心的な処理と責務をつかむためです。",
    },
    test: {
      reason: "期待される振る舞いを具体例から確認するためです。",
    },
  };

function depth(path: string): number {
  return path.split("/").length;
}

function pick(paths: readonly string[], score: (path: string) => number) {
  return [...paths].sort(
    (left, right) => score(right) - score(left) || left.localeCompare(right),
  )[0];
}

function pathUrl(repository: string, commitOid: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repository}/blob/${commitOid}/${encodedPath}`;
}

export function selectRepositoryReadingRoute(
  entries: readonly RepositoryTreeEntry[],
  repository: string,
  commitOid: string,
): RepositoryReadingCandidate[] {
  const paths = [
    ...new Set(
      entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path),
    ),
  ].filter((path) => path.length > 0 && path.length <= 1_024);
  const lower = (path: string) => path.toLocaleLowerCase("en-US");
  const selected: Array<{
    category: RepositoryReadingCategory;
    path: string | undefined;
  }> = [];

  selected.push({
    category: "overview",
    path: pick(
      paths.filter((path) => /^readme(?:\.[^/]+)?$/iu.test(path)),
      (path) => (lower(path) === "readme.md" ? 10 : 0),
    ),
  });

  const configNames = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "pipfile",
    "poetry.lock",
  ];
  selected.push({
    category: "configuration",
    path: pick(
      paths.filter(
        (path) =>
          !path.includes("/") &&
          (configNames.includes(lower(path)) ||
            /^requirements[^/]*\.txt$/iu.test(path)),
      ),
      (path) => 100 - (configNames.indexOf(lower(path)) + 1 || 50),
    ),
  });

  selected.push({
    category: "entrypoint",
    path: pick(
      paths.filter((path) =>
        /(?:^|\/)(?:__main__|main|cli|app|manage)\.py$/iu.test(path),
      ),
      (path) =>
        100 -
        depth(path) * 10 +
        (/\/(?:__main__|main|cli)\.py$/iu.test(path) ? 5 : 0),
    ),
  });

  const alreadySelected = () =>
    new Set(selected.map((item) => item.path).filter(Boolean));
  selected.push({
    category: "core",
    path: pick(
      paths.filter((path) => {
        const normalized = lower(path);
        return (
          normalized.endsWith(".py") &&
          !alreadySelected().has(path) &&
          !/(?:^|\/)(?:tests?|docs?|examples?|scripts?)\//u.test(normalized) &&
          !/(?:^|\/)test_[^/]+\.py$/u.test(normalized)
        );
      }),
      (path) =>
        (/^src\//u.test(lower(path)) ? 40 : 0) +
        (/(?:^|\/)__init__\.py$/u.test(lower(path)) ? -20 : 0) +
        Math.max(0, 30 - depth(path) * 5),
    ),
  });

  selected.push({
    category: "test",
    path: pick(
      paths.filter((path) => {
        const normalized = lower(path);
        return (
          normalized.endsWith(".py") &&
          (/(?:^|\/)tests?\//u.test(normalized) ||
            /(?:^|\/)test_[^/]+\.py$/u.test(normalized) ||
            /(?:^|\/)[^/]+_test\.py$/u.test(normalized))
        );
      }),
      (path) => 50 - depth(path) * 5,
    ),
  });

  return selected.flatMap(({ category, path }) =>
    path
      ? [
          {
            category,
            path,
            reason: CATEGORY_DETAILS[category].reason,
            url: pathUrl(repository, commitOid, path),
          },
        ]
      : [],
  );
}
