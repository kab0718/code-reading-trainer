# Code Reading Trainer

GitHub上のPythonコードを読み、その処理内容を自分の言葉で説明することで、コードリーディング力を鍛えるChrome拡張です。

現在は企画・初期設計段階です。プロダクトの狙い、MVP、学習体験、評価方針は [`docs/product-overview.md`](docs/product-overview.md)、今後の作業手順と完了条件は [`docs/implementation-plan.md`](docs/implementation-plan.md) にまとめています。

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
│   ├── implementation-plan.md
│   └── product-overview.md
├── src/
│   ├── background.js
│   ├── content.js
│   ├── sidepanel.css
│   ├── sidepanel.html
│   └── sidepanel.js
├── manifest.json
└── README.md
```

## 開発中の拡張機能を読み込む

1. Chromeで `chrome://extensions` を開く
2. 「デベロッパー モード」を有効にする
3. 「パッケージ化されていない拡張機能を読み込む」を選ぶ
4. このディレクトリを指定する

現時点では、GitHubページで拡張機能を開くとサイドパネルに初期画面が表示されるだけの骨組みです。
