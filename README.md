# Code Reading Trainer

GitHub上のPythonコードを読み、その処理内容を自分の言葉で説明することで、コードリーディング力を鍛えるChrome拡張です。

現在は企画・初期設計段階です。プロダクトの狙い、MVP、学習体験、評価方針は [`docs/product-overview.md`](docs/product-overview.md)、評価の配点とAPI契約は [`docs/evaluation-api-contract.md`](docs/evaluation-api-contract.md)、評価APIの構成と運用は [`docs/evaluation-api-operations.md`](docs/evaluation-api-operations.md)、今後の作業手順と完了条件は [`docs/implementation-plan.md`](docs/implementation-plan.md) にまとめています。

## 想定する体験

1. GitHubでソースコードのファイルを開く
2. システムが提示する関数・メソッド候補から1つ選ぶ、または任意のコードを選択する
3. そのコードが何をしているかを自分の言葉で説明する
4. 目的、主要処理、分岐・例外、副作用などの観点別の得点とフィードバックを受ける
5. 模範解答と自分の説明を比較して完了する

初期版の回答は1回限りとし、回答の書き直しと再評価は将来の機能として検討します。

## ディレクトリ構成

```text
code-reading-trainer/
├── docs/
│   ├── evaluation-api-contract.md
│   ├── evaluation-api-operations.md
│   ├── implementation-plan.md
│   └── product-overview.md
├── api/
│   ├── evaluation.ts
│   ├── workers-ai.ts
│   └── worker.ts
├── contracts/evaluation/v1/
│   ├── evaluation-error.schema.json
│   ├── evaluation-request.schema.json
│   ├── evaluation-response.schema.json
│   └── examples/
├── src/
│   ├── background.ts
│   ├── content.ts
│   ├── input-validation.ts
│   ├── page-context.ts
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
