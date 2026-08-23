# 評価仕様・API契約 v1

## 1. 目的と適用範囲

この文書は、MVPで利用する採点ルールと評価APIの入出力を定める。Chrome拡張と評価APIは、本文書および `contracts/evaluation/v1/` のJSON Schemaを共通の契約として参照する。

- エンドポイント: `POST /v1/evaluations`
- Content-Type: `application/json`
- 対応言語: Pythonのみ
- 契約バージョン: `1.0`

## 2. 評価軸と基本配点

| ID | 評価軸 | 基本配点 | 採点対象になる条件 |
| --- | --- | ---: | --- |
| `purpose` | 目的・責務 | 25 | 選択コードが担う役割や達成する結果を説明できる |
| `inputs_outputs` | 入出力 | 15 | 引数、参照する入力、返り値、yieldなどが存在する |
| `main_flow` | 主要処理 | 25 | 重要な処理順序やデータ変換が存在する |
| `branches_errors` | 分岐・例外 | 15 | 条件分岐、早期return、例外送出・処理、失敗条件が存在する |
| `side_effects` | 副作用 | 10 | 状態変更、I/O、DB、API、キャッシュ、ログなど外部への影響が存在する |
| `assumptions_dependencies` | 前提・依存 | 10 | 呼び出し先、外部状態、入力条件、型やライブラリへの重要な依存が存在する |

`purpose` と `main_flow` を中心に置き、コードの役割と主要な流れを説明する力へ全体の50点を配分する。対象コードから確認できない事実や、選択範囲外の実装詳細は採点根拠にしない。

### 2.1 対象外軸の扱い

評価APIは、まず各軸が対象コードに存在するかを判定する。対象外軸は減点せず、レスポンスでは次の形で明示する。

- `applicable: false`
- `maxScore: 0`
- `score: null`
- `feedback: null`
- `exclusionReason`: 対象外とした理由

対象軸は必ず1つ以上存在し、レスポンスの `criteria` には対象外を含む6軸を固定順で返す。

### 2.2 100点への再配分

対象軸の基本配点に比例して100点へ再配分し、整数化には最大剰余方式を使う。

1. 対象軸の基本配点合計を `W` とする。
2. 各対象軸の未丸め配点を `100 × 基本配点 ÷ W` とする。
3. 各未丸め配点を切り捨てる。
4. 合計が100になるまで、小数部分が大きい軸から1点ずつ加える。
5. 小数部分が同じ場合は、表の固定順を優先する。

例: `branches_errors` と `side_effects` が対象外の場合、対象軸の基本配点合計は75となり、再配分後は次のとおり。

| 評価軸 | 再配分後 |
| --- | ---: |
| 目的・責務 | 34 |
| 入出力 | 20 |
| 主要処理 | 33 |
| 前提・依存 | 13 |
| 合計 | 100 |

`totalScore` は対象軸の `score` の合計とし、0〜100の整数にする。

## 3. リクエスト

リクエストSchema: [`../contracts/evaluation/v1/evaluation-request.schema.json`](../contracts/evaluation/v1/evaluation-request.schema.json)

| フィールド | 必須 | 制約 |
| --- | --- | --- |
| `language` | 必須 | `python` 固定 |
| `sourceUrl` | 必須 | public repositoryのGitHub blob URL、最大2,048文字、`.py` ファイル |
| `code` | 必須 | 空白のみ不可、最大30,000文字 |
| `explanation` | 必須 | 空白のみ不可、最大5,000文字 |

JSON全体のUTF-8サイズ上限は64 KiBとする。上限判定はHTTP bodyの受信直後に行い、超過時は `PAYLOAD_TOO_LARGE` を返す。未知のフィールドは受け付けない。

正常リクエスト例: [`../contracts/evaluation/v1/examples/request.json`](../contracts/evaluation/v1/examples/request.json)

```json
{
  "language": "python",
  "sourceUrl": "https://github.com/example/project/blob/main/parser.py",
  "code": "def normalize_name(name):\n    return name.strip().lower()",
  "explanation": "名前の前後の空白を除去し、小文字に統一して返す関数です。"
}
```

## 4. 正常レスポンス

- HTTP status: `200 OK`
- Schema: [`../contracts/evaluation/v1/evaluation-response.schema.json`](../contracts/evaluation/v1/evaluation-response.schema.json)
- 例: [`../contracts/evaluation/v1/examples/response.json`](../contracts/evaluation/v1/examples/response.json)

```json
{
  "requestId": "4fd0d833-6bad-4d6e-b2e2-7fd9ba73710b",
  "contractVersion": "1.0",
  "totalScore": 88,
  "criteria": [
    {
      "id": "purpose",
      "label": "目的・責務",
      "applicable": true,
      "baseWeight": 25,
      "score": 34,
      "maxScore": 34,
      "feedback": "文字列を正規化する目的を説明できています。",
      "exclusionReason": null
    }
  ],
  "strengths": ["空白除去と小文字化の両方を説明できています。"],
  "gaps": ["入力が文字列である前提への言及がありません。"],
  "modelAnswer": "文字列を受け取り、前後の空白を除去してから小文字へ変換し、その結果を返します。",
  "evaluatedAt": "2026-08-15T12:00:00Z"
}
```

上の抜粋では可読性のため `criteria` を1件だけ示している。実際のレスポンスは、Schemaとサンプルファイルのとおり固定順で6件すべてを返す。

APIは次の整合性をSchema検証に加えて保証する。

- 対象軸の `maxScore` 合計は100
- `totalScore` は対象軸の `score` 合計と一致する
- `score` は0以上 `maxScore` 以下
- `id` は重複せず、6軸を固定順で返す
- `baseWeight` はこの文書の基本配点と一致する
- 模範解答は選択コードから確認できない事実を断定しない

## 5. エラーレスポンス

すべてのエラーは同じenvelopeで返す。

- Schema: [`../contracts/evaluation/v1/evaluation-error.schema.json`](../contracts/evaluation/v1/evaluation-error.schema.json)
- 例: [`../contracts/evaluation/v1/examples/error.json`](../contracts/evaluation/v1/examples/error.json)

```json
{
  "requestId": "d877eb02-05a7-4d4d-a049-026fb3469e2f",
  "contractVersion": "1.0",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "リクエストの入力値を確認してください。",
    "details": [
      {
        "field": "explanation",
        "reason": "1文字以上で入力してください。"
      }
    ],
    "retryable": false
  }
}
```

| HTTP status | `code` | 用途 | 再試行 |
| ---: | --- | --- | --- |
| 400 | `INVALID_JSON` | JSONとして解釈できない | 修正後のみ |
| 400 | `VALIDATION_ERROR` | 必須・形式・文字数制約違反 | 修正後のみ |
| 401 | `UNAUTHORIZED` | API利用者を認証できない | 認証後のみ |
| 413 | `PAYLOAD_TOO_LARGE` | JSON全体が64 KiBを超過 | 短縮後のみ |
| 429 | `RATE_LIMITED` | 利用回数制限超過 | `retryAfterSeconds` 経過後 |
| 500 | `INTERNAL_ERROR` | API内部の予期しない失敗 | 手動再試行可 |
| 502 | `MODEL_ERROR` | AI出力不正またはモデル側エラー | 手動再試行可 |
| 504 | `EVALUATION_TIMEOUT` | 評価が制限時間内に完了しない | 手動再試行可 |

エラーメッセージにはコード、回答、APIキー、モデルの生レスポンスを含めない。`details` は入力検証エラー以外では空配列にできる。

`retryable` は、同じ入力を変更せずに後から再送信できるかを表す。`RATE_LIMITED`、`INTERNAL_ERROR`、`MODEL_ERROR`、`EVALUATION_TIMEOUT` では `true`、それ以外では `false` とする。

## 6. タイムアウトと再試行

- API全体の処理期限は25秒とする。
- AIモデル呼び出し単体は23秒で中断する。ただしリクエスト開始からのAPI全体25秒期限が先に到来する場合は、その時点でモデル呼び出しも中断する。
- AIモデルの出力は固定JSONの構造、6軸の順序、対象外軸のnull規則、文字数、割合点の範囲と5点刻みを検証する。
- AIモデルの出力がJSONとして解釈できない、または検証に失敗した場合は、同じ23秒の処理期限内で検証規則を明示して1回だけ再生成する。再生成後も不正な場合は `502 MODEL_ERROR` とする。
- Chrome拡張は30秒でリクエストを中断する。
- Chrome拡張は自動再試行しない。エラー時は入力を保持し、ユーザー操作で再試行できるようにする。
- APIは期限超過時に `504 EVALUATION_TIMEOUT` を返せる場合は返す。接続自体が終了した場合も、クライアントでは同じタイムアウト表示として扱う。
- `429 RATE_LIMITED` の場合だけ `retryAfterSeconds` を必須とし、その時間が過ぎるまで再送信操作を無効化する。

## 7. 実装時の責務

### Chrome拡張

- 送信前に必須項目と文字数を検証する
- エラー時に回答を失わない
- `error.message` を表示し、`details` があれば該当入力へ紐づける
- 受信した点数を再計算して不整合を検出し、不正な結果を表示しない

### 評価API

- JSON Schemaと64 KiB上限を検証する
- `sourceUrl` がpublic GitHub repositoryのPythonファイルを指すことを検証する
- 適用軸を判定し、規定の再配分を行う
- AI出力をそのまま返さず、点数とフィールドの整合性を検証する
- コード、回答、source URL、モデルの生レスポンスを通常ログへ保存しない
- AIサービスの認証情報をレスポンスへ含めない

## 8. 変更ルール

後方互換なフィールド追加でも、Chrome拡張が未知フィールドを拒否するためSchemaと双方の実装を同時に更新する。必須フィールド、評価軸、配点、意味を変更する場合は `/v2` と新しい契約ディレクトリを作る。
