# 評価APIの構成と運用

## 配置先と技術構成

評価APIはCloudflare Workersへ配置する。`POST /v1/evaluations` の入出力は
[`evaluation-api-contract.md`](evaluation-api-contract.md) と
[`contracts/evaluation/v1/`](../contracts/evaluation/v1/) を正本とする。

- Workerエントリーポイント: [`api/worker.ts`](../api/worker.ts)
- AIサービス: Cloudflare Workers AI bindingのJSON Schema出力
- モデル名: `AI_MODEL`（初期値は `@cf/openai/gpt-oss-20b`）
- 利用制限: Cloudflare Workers Rate Limiting bindingで、許可した拡張機能Originと接続元IPの組み合わせごとに10回/60秒
- 利用元制限: `ALLOWED_EXTENSION_IDS` に列挙したChrome拡張機能IDだけを許可
- AI無料枠: Workers AIの10,000 Neurons/日を上限とし、超過時はUTC 00:00のリセットまで再試行可能な429を返す
- データ保存: アプリケーションではコード、説明、採点結果を永続化しない

拡張機能からWorkers AIを直接呼ばず、AI bindingはWorkerだけに公開する。`ALLOWED_EXTENSION_IDS` は認証用の秘密ではなく、CORSによる利用元制限である。実際の不正利用防止は利用元制限と接続元単位の回数制限を組み合わせて行う。非ブラウザのクライアントはOriginを偽装できるため、これは強い利用者認証ではない。一般公開前にはCloudflare WAFの制限も設定し、Neuron使用量と429応答を監視する。

## リクエスト処理

1. パス、HTTPメソッド、Content-Type、許可Originを検証する。
2. HTTP bodyを読み、UTF-8で64 KiB以下か確認する。
3. v1契約の必須フィールド、未知フィールド、型、文字数、言語、URL形式を検証する。
4. 利用回数制限を確認する。
5. `sourceUrl` へHEADリクエストし、公開されているGitHubのPythonファイルか確認する。
6. コードと説明だけをWorkers AI bindingへ送り、20秒で中断する。`sourceUrl` は送らない。
7. モデル出力を検証し、対象軸の満点を最大剰余方式で100点へ再配分してv1レスポンスを作る。

エラー本文や通常ログへコード、説明、source URL、モデルの生レスポンスを出力しない。

## ローカル実行

### 1. Cloudflareの準備

1. Cloudflareアカウントを用意し、Workers FreeプランとWorkers AIを利用できることをDashboardで確認する。
2. Node.js 24で依存関係をインストールする。
3. `npx wrangler login` で対象アカウントへログインし、`npx wrangler whoami` でアカウントを確認する。
4. Workers AIの有料プランや別の有料AIサービスは設定しない。MVPでは無料割当を超えたら429を返し、翌日のリセットを待つ。

複数のCloudflareアカウントへ参加している場合は、デプロイ前にも`wrangler whoami`のAccount IDを確認する。誤ったアカウントへのデプロイを避けるため、確認したAccount IDとWorker名を作業記録へ残す。

### 2. ローカル確認

開発用の変数ファイルを作成し、実際に読み込んだChrome拡張機能のIDを`ALLOWED_EXTENSION_IDS`へ設定してからWorkerを起動する。複数のIDを許可するときはカンマ区切りで指定する。Workers AI bindingの推論はローカル実行時もCloudflareの利用量へ計上される。

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

### 3. 本番設定の確認

初回デプロイ前に、次を確認する。

- `wrangler.jsonc` のWorker名が `code-reading-trainer-evaluation-api` である
- `ai.binding` が `AI`、`AI_MODEL` が採用モデルになっている
- `ALLOWED_EXTENSION_IDS` が公開する拡張機能IDで、空文字や開発用IDのままではない
- `ALLOW_MISSING_ORIGIN` が `false` である
- `RATE_LIMITER` の `namespace_id` が他用途と意図せず共有されておらず、10回/60秒になっている
- `observability` が有効で、コード、回答、source URL、モデルの生レスポンスをログへ出す処理がない
- `npm run check` が成功し、`dist/api` のdry-run bundleに秘密情報が含まれていない

Workers AIはWorkerの`AI` bindingから呼び出すため、外部AIサービスのAPIキーやCloudflare API TokenをWorker Secretへ登録する必要はない。Wranglerのログイン情報もリポジトリやWorker環境変数へ保存しない。

### 4. デプロイとURLの反映

```sh
npx wrangler deploy
```

コマンドが出力した`workers.dev` URLを記録し、次を同じ変更で確認する。

1. `src/evaluation-config.ts` の `EVALUATION_API_URL` に完全な `/v1/evaluations` URLを設定する。
2. URLが`manifest.json`の`optional_host_permissions`（`https://*.workers.dev/*`）に収まることを確認する。
3. `scripts/validate-extension.ts`のoptional host permission allowlistが同じpatternを維持していることを確認する。

接続先はruntime storageやメッセージから変更できない。URLが未設定の配布物は権限要求も外部送信も行わず、画面へ設定エラーを返す。URL設定後はパッケージ化した拡張機能をChromeへ読み込み、送信操作時に表示される接続許可が設定済み評価APIの正確なOriginであることを確認する。許可を拒否した場合は回答が保持され、許可した場合だけBackground Workerから正常系を1件送信できることを確認する。

カスタムドメインを使う場合は、`optional_host_permissions`とvalidator allowlistをその正確なOriginに変更してから、Cloudflare側のRoute設定後に同じ確認を行う。

`ALLOWED_EXTENSION_IDS` が空の場合、評価リクエストは `401 UNAUTHORIZED` になる。`ALLOW_MISSING_ORIGIN=true` はCLIなど信頼済みクライアントを使うローカル検証専用とし、本番では有効にしない。

### 5. デプロイ後の疎通確認

本番URLに対して次を確認し、HTTP status、`requestId`、実施時刻だけを作業記録へ残す。コードや回答の本文は記録しない。

1. 公開GitHub上の短いPythonコードと妥当な回答で`POST /v1/evaluations`が200を返す。
2. レスポンスがv1 Schemaに適合し、6評価軸、100点満点、模範解答を含む。
3. 許可した拡張機能OriginへのCORS headerが返る。
4. 未許可Originが401、壊れた入力、Python以外、非公開URLが400になる。
5. AI推論へ到達しない公開元URLエラーのリクエストを同一IPから続け、11回目が429になって`Retry-After`が返る。回数制限の確認でNeuronを消費しない。
6. 拡張機能から実際に1回評価し、送信中、成功、エラー時の回答保持を確認する。

正常系のAI推論は無料割当を消費するため、定型の短いサンプルで必要最小限だけ実行する。

### 6. 監視とロールバック

- Cloudflare DashboardでWorkers AIのNeuron使用量を日次確認し、10,000 Neurons/日に近づいたら追加の手動検証を止める。
- WorkerのObservabilityで4xx、5xx、タイムアウト、429の増加を確認する。ログ本文へ利用者のコードや回答を追加しない。
- 一般公開前にCloudflare WAFで、想定外のHTTPメソッドや明らかな大量アクセスを抑止するルールを設定する。
- 障害時は`npx wrangler deployments`で直前の正常なversionを確認し、Cloudflare Dashboardまたは`npx wrangler rollback <version-id>`で戻す。
- ロールバック後も正常系1件と未許可Originの疎通確認を行う。

Rate Limiting bindingはCloudflareの仕様上、低遅延を優先したeventually consistentな制限である。厳密な課金上限やユーザー単位の利用枠が必要になった場合は、利用者認証とDurable Objects等による強整合なカウンターへ移行する。

Workers AIのFreeプランでは1日10,000 Neuronsを超えると推論が拒否される。APIはCloudflareの無料割当超過エラーを`429 RATE_LIMITED`へ変換し、次のUTC 00:00までの秒数を`Retry-After`と`retryAfterSeconds`へ設定する。有料プランや別の有料モデルへの自動フォールバックは行わない。
