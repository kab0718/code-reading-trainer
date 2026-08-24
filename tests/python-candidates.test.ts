import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractPythonDefinitions,
  selectTrainingCandidates,
} from "../src/python-candidates.ts";

test("デコレータを含む関数・直下メソッドを完全な範囲で抽出する", () => {
  const source = [
    "@first",
    "@app.command()",
    "async def load(value: int):",
    "    if value:",
    "        return value",
    "    return 0",
    "",
    "class Service:",
    "    @classmethod",
    "    def create(cls, value):",
    "        normalized = str(value)",
    "        return cls(normalized)",
    "",
    "    class Nested:",
    "        def ignored(self):",
    "            value = 1",
    "            return value",
    "",
    "def outer(value):",
    "    def nested():",
    "        return value",
    "    return nested()",
    "",
    "if enabled:",
    "    def conditional(value):",
    "        result = value + 1",
    "        return result",
  ].join("\n");

  const definitions = extractPythonDefinitions(source);

  assert.deepEqual(
    definitions.map(({ kind, name }) => ({ kind, name })),
    [
      { kind: "function", name: "load" },
      { kind: "method", name: "create" },
      { kind: "function", name: "outer" },
    ],
  );
  assert.equal(definitions[0]?.code, source.split("\n").slice(0, 7).join("\n"));
  assert.match(
    definitions[1]?.code ?? "",
    /^[ ]{4}@classmethod\n[ ]{4}def create/u,
  );
});

test("短いアクセサを除外し最大3件へ難易度・時間・理由を付ける", () => {
  const source = [
    "def get_value(value):",
    "    return value",
    "",
    "def simple(items):",
    "    result = []",
    "    for item in items:",
    "        result.append(item)",
    "    return result",
    "",
    "def medium(items):",
    "    result = []",
    "    for item in items:",
    "        if item:",
    "            result.append(item)",
    "    return result",
    "",
    "def hard(items):",
    "    try:",
    "        for item in items:",
    "            if item:",
    "                yield item",
    "    except TypeError:",
    "        return",
    "",
    "def extra(items):",
    "    total = 0",
    "    for item in items:",
    "        total += item",
    "    return total",
  ].join("\n");
  const sourceUrl = `https://github.com/example/project/blob/${"a".repeat(40)}/module.py`;

  const candidates = selectTrainingCandidates(
    extractPythonDefinitions(source),
    sourceUrl,
  );

  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map(({ level }) => level),
    ["warmup", "recommended", "challenge"],
  );
  assert.ok(candidates.every((candidate) => candidate.estimatedMinutes > 0));
  assert.ok(candidates.every((candidate) => candidate.reason.length > 0));
  assert.ok(candidates.every((candidate) => candidate.name !== "get_value"));
});

test("短すぎる定義だけなら候補なしを返す", () => {
  const source = "def value():\n    return 1\n";
  assert.deepEqual(
    selectTrainingCandidates(
      extractPythonDefinitions(source),
      `https://github.com/example/project/blob/${"b".repeat(40)}/module.py`,
    ),
    [],
  );
});

test("module headerが自動生成を示すファイルは候補にしない", () => {
  const source = [
    "# Generated code. DO NOT EDIT.",
    "def normalize(value):",
    "    result = str(value)",
    "    if result:",
    "        return result",
    "    return None",
  ].join("\n");
  assert.deepEqual(extractPythonDefinitions(source), []);
});

test("docstring付きproperty getterと単純setterを除外する", () => {
  const source = [
    "class Value:",
    "    @property",
    "    def value(self):",
    '        """現在値。"""',
    "        return self._value",
    "",
    "    @value.setter",
    "    def value(self, new_value):",
    "        self._value = new_value",
    "",
    "    def normalize(self, value):",
    "        result = str(value)",
    "        if result:",
    "            return result",
    "        return None",
  ].join("\n");
  const sourceUrl = `https://github.com/example/project/blob/${"c".repeat(40)}/value.py`;

  const candidates = selectTrainingCandidates(
    extractPythonDefinitions(source),
    sourceUrl,
  );

  assert.deepEqual(
    candidates.map(({ name }) => name),
    ["normalize"],
  );
});

test("未対応デコレータのerror recoveryを候補として誤採用しない", () => {
  const unsupported = [
    "@registry[name]",
    "def recovered(value):",
    "    result = value + 1",
    "    return result",
  ].join("\n");
  assert.deepEqual(extractPythonDefinitions(unsupported), []);

  const supported = [
    "@app.command(",
    '    name="run",',
    ")",
    "def command(value):",
    "    result = value + 1",
    "    return result",
  ].join("\n");
  assert.equal(extractPythonDefinitions(supported)[0]?.name, "command");
});

test("多数の定義でも行番号計算を線形時間相当に保つ", { timeout: 2_000 }, () => {
  const source = Array.from(
    { length: 4_000 },
    (_, index) =>
      `def item_${index}(value):\n    result = value + ${index}\n    if result:\n        return result\n    return 0\n`,
  ).join("\n");

  const definitions = extractPythonDefinitions(source);

  assert.equal(definitions.length, 4_000);
  assert.equal(definitions.at(-1)?.name, "item_3999");
});
