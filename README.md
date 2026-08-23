# Code Reading Trainer

GitHub上のPythonコードを自分の力で読み解くためのChrome拡張です。理解を説明して採点を受けるトレーニングと、実際のOSS読解で着眼点や段階的なヒントを得る読解サポートを提供します。

プロダクトの狙い、MVP、学習体験、評価方針は [`docs/product-overview.md`](docs/product-overview.md)、Python関数・メソッド候補の抽出方式は [`docs/python-candidate-extraction.md`](docs/python-candidate-extraction.md)、評価の配点とAPI契約は [`docs/evaluation-api-contract.md`](docs/evaluation-api-contract.md)、読解サポートAPIの段階と契約は [`docs/reading-support-api-contract.md`](docs/reading-support-api-contract.md)、評価APIの構成と運用は [`docs/evaluation-api-operations.md`](docs/evaluation-api-operations.md)、今後の作業手順と完了条件は [`docs/implementation-plan.md`](docs/implementation-plan.md) にまとめています。

## 想定する体験

1. GitHubでソースコードのファイルを開く
2. システムが提示する関数・メソッド候補から1つ選ぶ、または任意のコードを選択する
3. 目的に応じてトレーニングまたは読解サポートを選ぶ
4. トレーニングでは、そのコードが何をしているかを自分の言葉で説明する
5. 目的、主要処理、分岐・例外、副作用などの観点別の得点とフィードバックを受ける
6. 読解サポートでは、分からない点や調査目的を入力し、着眼点や段階的なヒントを受ける
7. 必要な場合だけ詳しい説明を確認する

トレーニングの回答は1回限りとし、回答の書き直しと再評価は将来の機能として検討します。初期の読解サポートは選択コードを対象とし、リポジトリ全体の自動解析は行いません。

## ディレクトリ構成

```text
code-reading-trainer/
├── docs/
│   ├── evaluation-api-contract.md
│   ├── evaluation-api-operations.md
│   ├── implementation-plan.md
│   ├── python-candidate-extraction.md
│   ├── reading-support-api-contract.md
│   └── product-overview.md
├── api/
│   ├── evaluation.ts
│   ├── reading-support.ts
│   ├── workers-ai.ts
│   ├── workers-reading-support.ts
│   └── worker.ts
├── contracts/
│   ├── evaluation/v1/
│   └── reading-support/v1/
├── src/
│   ├── analytics.ts
│   ├── background.ts
│   ├── content.ts
│   ├── input-validation.ts
│   ├── page-context.ts
│   ├── reading-support-contract.ts
│   ├── sidepanel.css
│   ├── sidepanel.html
│   └── sidepanel.ts
├── tests/
│   └── *.test.ts
├── tsconfig.json
├── tsconfig.extension.json
├── tsconfig.tests.json
├── manifest.json
└── README.md
```

## 開発中の拡張機能を読み込む

1. `npm run build` でTypeScriptをコンパイルする
2. Chromeで `chrome://extensions` を開く
3. 「デベロッパー モード」を有効にする
4. 「パッケージ化されていない拡張機能を読み込む」を選ぶ
5. `dist/extension` ディレクトリを指定する

public repositoryのPythonコード表示ページを開くと、URL、repository、ref、ファイルパスを判定し、選択したコードをサイドパネルへ取り込めます。Python以外のファイル、コード表示以外のページ、private repositoryは対象外として案内します。

GitHub内の画面遷移後も表示中のページを再判定します。

## 開発時の確認

Node.js 24を使用します。依存関係をインストールしたあと、単体テストを含む品質チェックを実行してください。

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` はフォーマット、Lint、型チェック、単体テスト、Chrome拡張のビルド・検証、評価APIのdry-run bundleを順に確認します。拡張機能だけを再ビルドするときは `npm run build` を実行してください。

評価APIをローカル実行またはデプロイする手順は [`docs/evaluation-api-operations.md`](docs/evaluation-api-operations.md) を参照してください。
