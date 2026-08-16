# 評価APIの構成と運用

## 配置先と技術構成

評価APIはCloudflare Workersへ配置する。`POST /v1/evaluations` の入出力は
[`evaluation-api-contract.md`](evaluation-api-contract.md) と
[`contracts/evaluation/v1/`](../contracts/evaluation/v1/) を正本とする。

- Workerエントリーポイント: [`api/worker.mjs`](../api/worker.mjs)
- AIモデル: OpenAI Responses APIのStructured Outputs
- モデル名: `OPENAI_MODEL`（初期値は `gpt-5-mini`）
- AI認証情報: Worker Secretの `OPENAI_API_KEY`
- 利用制限: Cloudflare Workers Rate Limiting bindingで、許可した拡張機能Originと接続元IPの組み合わせごとに10回/60秒
- 利用元制限: `ALLOWED_EXTENSION_IDS` に列挙したChrome拡張機能IDだけを許可
- データ保存: アプリケーションでは保存せず、OpenAIへのリクエストも `store: false` とする

拡張機能へOpenAI APIキーやWorker Secretを含めない。`ALLOWED_EXTENSION_IDS` は認証用の秘密ではなく、CORSによる利用元制限である。実際の不正利用防止は利用元制限と接続元単位の回数制限を組み合わせて行う。非ブラウザのクライアントはOriginを偽装できるため、これは強い利用者認証ではない。一般公開前にはCloudflare WAFの制限とOpenAI projectの利用上限も設定し、利用状況を監視する。

## リクエスト処理

1. パス、HTTPメソッド、Content-Type、許可Originを検証する。
2. HTTP bodyを読み、UTF-8で64 KiB以下か確認する。
3. v1契約の必須フィールド、未知フィールド、型、文字数、言語、URL形式を検証する。
4. 利用回数制限を確認する。
5. `sourceUrl` へHEADリクエストし、公開されているGitHubのPythonファイルか確認する。
6. コードと説明だけをOpenAIへ送り、20秒で中断する。`sourceUrl` は送らない。
7. モデル出力を検証し、対象軸の満点を最大剰余方式で100点へ再配分してv1レスポンスを作る。

エラー本文、通常ログ、モデル入力へAPIキーを出力しない。コード、説明、source URL、モデルの生レスポンスもログへ出力しない。

## ローカル実行

Node.js 24を使用する。開発用の変数ファイルを作成してからWorkerを起動する。

```sh
cp .dev.vars.example .dev.vars
npx wrangler dev
```

`.dev.vars` はGit管理対象外である。ローカルでは `wrangler.jsonc` の `ALLOWED_EXTENSION_IDS` を実際の拡張機能IDへ変更するか、対応する環境変数を設定する。

契約テスト、静的検査、Workerのbundle確認は次で実行する。

```sh
npm run check
```

## デプロイ

初回デプロイ前に、`wrangler.jsonc` の `ALLOWED_EXTENSION_IDS` を公開する拡張機能IDへ変更する。OpenAI APIキーはリポジトリや通常の環境変数へ書かず、Secretとして登録する。

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

`ALLOWED_EXTENSION_IDS` が空の場合、評価リクエストは `401 UNAUTHORIZED` になる。`ALLOW_MISSING_ORIGIN=true` はCLIなど信頼済みクライアントを使うローカル検証専用とし、本番では有効にしない。

Rate Limiting bindingはCloudflareの仕様上、低遅延を優先したeventually consistentな制限である。厳密な課金上限やユーザー単位の利用枠が必要になった場合は、利用者認証とDurable Objects等による強整合なカウンターへ移行する。
