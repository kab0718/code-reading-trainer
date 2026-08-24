# 評価APIの本番デプロイ記録

## デプロイ先

| 項目               | 値                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------ |
| Cloudflare Account | 個人用アカウント（公開文書ではメールアドレスを含むDashboard表示名を非掲載）          |
| Account ID         | `71a202970c92fc46112dcdead889c6d2`                                                   |
| Worker             | `code-reading-trainer-evaluation-api`                                                |
| URL                | `https://code-reading-trainer-evaluation-api.kab-nan.workers.dev`                    |
| 評価API            | `https://code-reading-trainer-evaluation-api.kab-nan.workers.dev/v1/evaluations`     |
| 読解サポートAPI    | `https://code-reading-trainer-evaluation-api.kab-nan.workers.dev/v1/reading-support` |
| Version ID         | `e868d9a4-33a7-4c33-8629-c45a729be62e`                                               |
| 作成日時           | 2026-08-24 15:14 UTC（2026-08-25 00:14 JST）                                         |
| Chrome拡張機能ID   | `ehnigfmicfjegdnajlagdiccfnlocjfk`                                                   |

## 本番設定

- Workers AI: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Rate Limiting: namespace `1002`、接続元とOriginごとに10リクエスト/60秒
- CORS: 上記Chrome拡張機能IDだけを許可し、Originなしのリクエストは拒否
- 許可IDの保管: Worker Secret `ALLOWED_EXTENSION_IDS_SECRET`（リポジトリには値を置かない）
- Observability: 有効、head sampling rate `1`
- Workers AI無料割当: 10,000 Neurons/日。有料プランや別モデルへの自動フォールバックなし
- 2026-08-24のデプロイ確認後のDashboard表示: 6.45k/10k Neurons

namespace `1001` は別Workerも利用していたため、このWorker専用の `1002` へ変更した。異なるWorkerで同じnamespaceを再利用しない。

## デプロイ後確認

2026-08-24に `npm run verify:deployment` と展開済みChrome拡張機能で確認した。

| 確認項目                   | 実施時刻（UTC）         | 結果                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CORS preflight             | 2026-08-23 18:42〜18:43 | `204`、許可Originと `Vary: Origin` を確認                                                                                                                                                                                                                                         |
| 許可されていない拡張Origin | 2026-08-23 18:42〜18:43 | `401 UNAUTHORIZED`、request ID `1c7244d0-ed12-433a-af0e-4f3effbe513e`                                                                                                                                                                                                             |
| Originヘッダーなし         | 2026-08-23 19:04        | `401 UNAUTHORIZED`、CORS headerなし、request ID `18a2204a-f291-40ea-9f76-10500e341bcf`                                                                                                                                                                                            |
| 壊れたJSON                 | 2026-08-23 18:42〜18:43 | `400 INVALID_JSON`、request ID `63f8c17d-a9a4-45f6-9286-496fc6550321`                                                                                                                                                                                                             |
| Python以外のlanguage       | 2026-08-23 18:42〜18:43 | `400 VALIDATION_ERROR`、request ID `5dd68e5f-f85c-492b-9d40-b5204116c573`                                                                                                                                                                                                         |
| 存在しない公開形式URL      | 2026-08-23 19:02        | `400 VALIDATION_ERROR`、request ID `b1d01573-6a6f-4770-a7f6-0ed8833cedde`                                                                                                                                                                                                         |
| 正常な評価                 | 2026-08-23 18:42〜18:43 | `200`、v1 JSON Schema適合、request ID `007d825a-cc3c-4a13-90d3-4968f2ecc4f2`                                                                                                                                                                                                      |
| Rate Limiting              | 2026-08-23 19:02        | 現行Versionの間隔付き検証の12件目で `429 RATE_LIMITED`、header/bodyとも待機時間60秒、request ID `67bda045-19b1-4fa7-a3b5-caf1b1ae9927`                                                                                                                                            |
| 拡張機能UI                 | 2026-08-23 18:53        | 本番APIへ接続し、再試行後に100/100点の結果と模範解答を表示                                                                                                                                                                                                                        |
| 現行Versionの基本疎通      | 2026-08-23 19:01        | AIを使わず `204`、`401`、`400` を再確認。401 request ID `9c0c90b2-11b7-4b37-ad71-af1cd5fa2415`                                                                                                                                                                                    |
| Secret移行後の基本疎通     | 2026-08-24 15:14〜15:15 | AIを使わず `204`、未許可Origin `401`（request ID `736c65c5-eca5-4e42-afad-df9acaf5414c`）、Originなし `401`（`c7ecaf28-2955-4410-89a1-7eaacaeef156`）、壊れたJSON `400`（`ad3169de-5c1e-41a9-a0e4-9e7b299a71fc`）、非Python `400`（`0c4b1450-13ea-4ce9-a7c5-5ef057986487`）を確認 |

Cloudflare Rate Limitingは近似カウンタで反映も非同期なため、429になるリクエスト番号は厳密に11件目とは限らない。設定値と `Retry-After` が本番で有効なことを確認対象とする。

拡張機能UIの自動確認では、未ログインのテスト用ChromiumでGitHubのページメタデータを取得できなかったため、公開Pythonファイルのページコンテキストだけをテスト用に固定した。展開した拡張機能、Background Worker、host permission、本番API、Workers AI、レスポンス表示は実物を使用した。

## 監視と公開範囲

- Worker Logsで成功、4xx、429、5xx、タイムアウトを確認する。
- ログにはリクエスト本文、対象コード、回答、モデルの生出力を追加しない。デプロイ確認時のWorker Logsにもこれらが記録されていないことを確認済み。
- Workers AIのNeuron使用量を日次確認し、10,000 Neuronsへ近づいたら手動検証を止める。
- 現時点はChrome Web Storeの限定ユーザーだけが利用する未公開テストのため、WAFルールは設定しない。一般公開へ切り替える前にWAFまたは強い利用者認証を追加する。
- Chrome拡張Originの制限は秘密情報による認証ではない。限定公開中もRate LimitingとNeuron使用量の監視を継続する。
- `workers.dev` URL、拡張機能ID、Originは公開情報であり、非ブラウザクライアントはOriginを偽装できる。限定公開フェーズでは、分散アクセスによる無料割当消費を完全には防げないリスクを受容し、Neuron使用量の異常時はWorkerを無効化する。選定ユーザーを検証するCloudflare Access/JWT等の認証は一般公開前の必須事項とする。

## ロールバック

正常評価と拡張機能UIを確認した直前のVersion IDは `a8ca73d2-c927-43f2-aae7-9cb45a2b84bd`。現行VersionでSecret参照に問題が起きた場合は、許可IDを通常変数に持つこのVersionへ次で戻す。

```bash
npx wrangler rollback a8ca73d2-c927-43f2-aae7-9cb45a2b84bd \
  --name code-reading-trainer-evaluation-api \
  --message "Issue #20 deployment rollback"
```

このロールバック先もRate Limiting namespace `1002`、モデル28秒、API全体31秒の正常確認済み設定である。復旧後は原因を修正し、`npx wrangler deploy` で新しいVersionを作成して同じ疎通確認を行う。
