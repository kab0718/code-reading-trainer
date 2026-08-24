# Python関数・メソッド候補の抽出方式

## 1. この文書の目的

おまかせトレーニングで、GitHub上のpublic repositoryにあるPythonファイルから、途中で切れていない関数・メソッドの候補を抽出する方式を定める。

この決定は候補の構文範囲を特定するところまでを対象とする。候補を最大3件へ絞り込む難易度判定、短すぎる関数や単純なアクセサの除外、推薦理由の生成は後段の選出ロジックの責務とする。

## 2. 決定

- PythonソースはChrome拡張のBackground WorkerからGitHub Contents REST APIで取得し、画面が表示したcommit OIDをimmutable refとして使う
- 構文解析は拡張機能へ同梱した `@lezer/python` でBackground Worker内にて行う
- 構文木の位置情報から対象範囲を切り出し、正規表現やインデント走査だけでは関数終端を決めない
- ファイル全体や候補内に構文エラーがあっても解析結果を無条件には採用せず、エラーノードを含む定義、および直前のerror recoveryから切り離された定義は候補から除外する
- 取得したファイル本文は永続化せず、評価APIへはユーザーが選んだ候補だけを既存の採点フローで送る

LezerはJavaScriptモジュールとして動き、各構文ノードの開始・終了位置を返す。PythonランタイムやWasmファイルを別途配布せず、現在のChrome Manifest V3拡張へ組み込みやすいことを重視した。実装時はパーサーと依存モジュールをBackground Workerの配布ファイルへbundleし、実行時にCDNからコードを読み込まない。

## 3. 方式比較

| 方式                                    | 構文範囲の信頼性                                                                                                    | 配布サイズ                                                                    | 処理時間                                                                                 | 保守性                                                                                 | 当方APIコスト                            | 判定   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- | ------ |
| ブラウザ同梱パーサー（`@lezer/python`） | 構文木の位置を利用でき、複数行、デコレータ、`async def`、ネストを文法として扱える。エラーノードの明示的な除外は必要 | JavaScriptの文法テーブルとruntimeが増える。実装時にbundle前後の実測を記録する | GitHubからの本文取得後に端末内で1回解析する。ネットワーク往復や当方API待ち時間は増えない | 薄い構文木adapterだけを自前で保守し、Python文法処理は固定versionの依存へ委ねられる     | なし                                     | 採用   |
| API側のPython `ast`                     | CPythonと同じASTを利用でき、対象Python versionを固定すれば最も厳密                                                  | 拡張機能の増分は小さい                                                        | ファイル全体の送信とAPI往復が候補表示のたびに発生する                                    | 現在のCloudflare Workers/TypeScriptとは別にPython実行環境、version管理、障害対応が必要 | 候補表示ごとに実行・転送コストが発生する | 不採用 |
| 限定ルール（正規表現、インデント走査）  | 単純な定義は軽量だが、文字列、コメント、継続行、デコレータ、ネストをまたぐ終端判定を自前で再実装することになる      | 最小                                                                          | 端末内で線形走査できる                                                                   | 対応構文の追加ごとに擬似パーサーが複雑化し、境界不具合の回帰範囲が広い                 | なし                                     | 不採用 |

API側Python ASTを不採用とする主因は、精度ではなく現行アーキテクチャとの不一致である。将来、候補選出をサーバー上のリポジトリ横断解析へ拡張し、Python実行環境を別の目的でも運用する場合は再検討できる。

限定ルールは依存追加を避けられるが、「候補として表示したコード範囲が途中で切れていない」というMVPの完了条件を満たすための保守負担が高い。定義の先頭候補を探す補助に正規表現を使うことは許容するが、開始・終了位置の正本にはしない。

ブラウザ向けパーサーの中では、純粋なJavaScriptで配布できるLezerを採用する。Wasm版Tree-sitterも同等の範囲取得が可能だが、Wasm本体とPython grammar assetの配置、Manifest V3のCSP、非同期初期化を追加で扱う必要があり、本用途では優位性が小さい。

## 4. 対応する構文

初期実装では、UTF-8のPythonファイルに含まれる次の定義を抽出できるようにする。

- module直下の `def`
- module直下の `async def`
- module直下のclassに直接属するinstance method、class method、static method
- 複数行の引数list、戻り値annotation、型annotationを持つ定義
- 0個以上の対応デコレータを持つ定義。MVPで対応するデコレータは、dotted nameと、その末尾に任意で引数呼び出しを持つ形式（`@classmethod`、`@app.command()` など）に限定する
- 対応デコレータがある場合、候補範囲には連続するデコレータの先頭行から関数本体の末尾までを含める
- 本体に分岐、例外処理、内包表記、複数行文字列、ネストしたblockを含む定義
- ファイル末尾に改行がない定義

構文上の開始位置は、対応デコレータがあればその外側の定義node、なければ関数定義nodeの `from` とする。候補のsource rangeは、その位置を含む行の行頭からnodeの `to` までへ拡張する。これによりclass内のdecorated methodでも、最初の `@` の前にあるindentを失わず、全行を元ファイルと同じindentで保持する。

候補の `code` は取得したsource stringをこのsource rangeで直接 `slice` して作る。位置計算前後にdedent、改行変換、Unicode正規化を行わず、文字列literalの内容を含めて表示するコードと解析したコードを一致させる。開始・終了offsetと行番号は元source上の位置として返す。methodのcodeは単体でcompileできる形へ変形するのではなく、元ファイル上で完全な構文範囲を保つ。

## 5. 対応しない構文・対象外にする定義

次はMVPの候補に含めない。

- 関数内に定義されたnested function、および関数内のlocal classに属するmethod
- class内のclassなど、module直下ではないclassに属するmethod
- `lambda`、動的に生成された関数、別ファイルからimportされた関数
- 文法error recoveryを示すエラーノードを候補範囲内に含む定義
- PEP 614で許可された一般式のデコレータ（`@registry[name]`、`@(decorator_factory())` など）
- 利用する `@lezer/python` の固定versionが解釈できない新しいPython構文を含む定義
- UTF-8としてdecodeできないファイル、GitHub APIが通常fileのraw本文として返さないresource
- サイズ上限を超えるファイル、生成物やnotebookなど `.py` 以外のファイル

nested functionは構文木上では認識するが、外側のローカル変数や制御フローへの依存が強く、単体の読解教材として説明に必要な文脈が不足しやすいため除外する。外側の関数候補には、その本体の一部としてnested functionを含める。

構文エラーが候補外にだけ存在する場合、エラーを含まない定義は利用できる。ファイルの一部のエラーを理由に全候補を捨てるのではなく、各候補の部分木にエラーノードがないことを基本条件にする。

ただしLezerのerror recoveryでは、未対応のデコレータをエラーを含むnodeと独立した `FunctionDefinition` へ分離する場合がある。部分木だけが正常でも、同一blockの直前にある未完了のdecorated definition、または候補へ連続するdecorator preludeにエラーがある場合は候補を棄却する。decorator preludeは、候補と同じindentで `@` から始まる直前の論理行と、その継続行である。候補へ含めるデコレータが対応形式だけであることも検証する。

独立した不正文のerror nodeまで後続の正常な定義へ波及させない。decorated definitionやdecorator preludeに帰属しないerrorとの間に完全なstatement境界がある場合、その後の正常な定義は利用できる。パーサー未対応構文が広範囲へ影響するfixtureは回帰テストへ追加し、誤った部分範囲を返すより候補なしへ倒す。

## 6. GitHubからファイル本文を取得する方法

Content Scriptは埋め込みページ情報から、表示中blobの `repository`、ref名、`path` に加えてcommit OIDを取得する。Background Workerは、Content Scriptの結果をそのまま信用せず、message senderのtab URLとの一致、public repository、値の型と長さ、`.py` suffix、commit OIDが40文字または64文字の16進数であることを再検証する。検証済みの `repository`、commit OID、`path` だけを固定のGitHub API URL builderへ渡し、呼び出し先hostを入力から変更できないようにする。

commit OIDはページ変更判定とUI状態のidentityにも含める。同じbranch URL、repository、ref名、pathのままcommit OIDだけが変わった場合も、Content Scriptはページ変更を通知し、Side Panelは前の候補・対象コード・回答をresetして新しいOIDの候補を取得する。候補requestにはimmutable context key（repository / commit OID / path）とrequest IDを付け、response受信時のcurrent contextと一致しない古いresponseは表示せず棄却する。

防御的な入力上限として、ownerとrepository名は各100文字、ref名は1,024文字、pathは4,096文字、tab URLは8,192文字までとする。空segment、NUL、`.` / `..` path segment、decodeに失敗する値を拒否し、URL生成には文字列連結ではなく `URL` とsegment単位のencodeを使う。これらはGitHubの仕様上限を表す値ではなく、不正messageによるrate limit消費とcache key肥大化をBackground境界で抑える製品側の上限である。

```text
GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={commitOid}
Accept: application/vnd.github.raw+json
X-GitHub-Api-Version: 2022-11-28
```

このendpointはpublic repositoryであれば認証なしで利用でき、`ref` と `path` を別々に渡せる。ref名ではなく、ページが実際に表示したimmutableなcommit OIDを `ref` に指定するため、閲覧中にbranchが移動しても画面と異なる版を取得しない。repositoryとpathの各segment、commit OIDはそれぞれpercent-encodeする。ページ情報からcommit OIDを確認できない場合はref名で代替せず、ページの再読み込みまたは別のpublic Pythonファイルでの再試行を案内する。実装時は `https://api.github.com/*` を `host_permissions` へ追加する。

評価APIへ渡す `sourceUrl` に現在のbranch URLを再利用しない。検証済みのowner、repository、commit OID、pathから、固定builderで次のimmutable blob permalinkを生成する。

```text
https://github.com/{owner}/{repo}/blob/{commitOid}/{path}
```

各segmentをpercent-encodeしたASCII URLが `https://github.com` のPython blob URLであり、`.py` で終わり、既存評価契約の2,048文字以下であることを候補提示前に検証する。取得には成功してもpermalinkが契約を満たさない場合、そのファイルからおすすめ候補を提示しない。これにより、回答中にbranchが移動しても取得したcodeと評価APIが存在確認するURLのcommitを一致させる。

GitHubのcode表示DOMから本文を組み立てる方式は採用しない。DOM構造変更、長いファイルのvirtualization、行番号や装飾の混入が取得結果に影響するためである。`raw.githubusercontent.com` のURLを直接組み立てる方式も、`ref` と `path` の境界をURL pathだけで表す必要があるため、Contents APIを正本とする。

MVPはpublic repositoryだけを対象とするため、GitHub tokenを拡張機能へ保存しない。未認証REST APIのprimary rate limitは送信元IP単位で1時間60requestであるため、同一の `repository` / commit OID / `path` に対する同時requestをまとめる。commit OIDはimmutableなので、成功した取得結果だけをmemory cacheへ保存する。cacheはLRUで最大8entryかつ合計4 MiBまでとし、どちらかを超える前に古いentryを破棄する。in-flight requestと成功cacheは分離し、失敗、timeout、abort時はin-flight entryを必ず削除して再試行を妨げない。

`403` / `429` とrate limit headerを識別し、候補を表示できない場合は再試行または別のpublic Pythonファイルを開くよう案内する。rate limitを増やすためのtoken導入はMVP対象外とする。

取得処理では以下を検証する。

- ページcontextがpublic repositoryの `.py` を示している
- commit OIDとsender tab URLがページcontextに一致し、repository、path、各入力値が上限内である
- HTTP statusが成功であり、responseが通常fileのraw本文である
- `Content-Length` がある場合は読み込み前に上限を確認する。本文は `ReadableStream` から逐次読み込みし、headerの有無にかかわらず累積1 MiBを超えた時点で `reader.cancel()` して以降のchunkを保持しない
- `TextDecoder("utf-8", { fatal: true })` でdecodeできる
- timeout、abort、`404`、`403` / `429`、`5xx` を区別した内部errorへ変換する

ファイルサイズ上限の初期値は1 MiBとする。候補抽出に不向きな巨大ファイルでBackground Workerを長時間占有しないための製品側上限であり、GitHub endpoint自体の最大値とは別である。

## 7. 実装の境界

実装は次の責務へ分ける。実際のファイル名は既存構成との整合を保つ範囲で変更してよいが、ネットワーク取得、構文抽出、候補選出を1つの関数へ混在させない。

| 境界          | 入力                                                | 出力・責務                                                                                                                                                                             |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ページcontext | GitHubの現在URLと埋め込みページ情報                 | 検証済みのpublic `repository`、ref名、commit OID、`.py` の `path`。commit OIDをページ変更signatureに含める                                                                             |
| source取得    | sender情報、ページcontext、注入可能な `fetch`       | Background境界で再検証したUTF-8 source、immutable `sourceUrl`、取得error。固定hostのGitHub API、streaming size上限、timeout、status、in-flight dedupe、有界cacheを担当                 |
| 構文抽出      | source string、固定したLezer parser                 | 名前、function/method種別、元source上の開始・終了offsetと行、対応decoratorと行頭indentを含むcode。候補内とdecorator recovery領域のerror検査を担当し、ネットワークや推薦scoreを扱わない |
| 候補選出      | 抽出済み定義のmetadata、code、immutable `sourceUrl` | 短さ、アクセサ、複雑度、評価APIのURL/code契約と最小request byte数を評価し、評価不能な定義を除外して最大3件へ分類する。構文境界を変更しない                                             |
| UI/採点       | immutable context key、request ID、選出済み候補     | OID変更時の状態reset、stale response棄却、候補表示、ユーザー選択、実際の回答を含むserialized requestの送信前検証、immutable `sourceUrl` とcodeの既存評価APIへの受け渡し                |

Lezerのversionは `package-lock.json` で固定する。依存の更新時は構文fixtureをすべて再実行し、node名や範囲の互換性を確認してから更新する。

## 8. テストの境界

### source取得の単体テスト

`fetch` を注入し、実際のGitHubへ接続せずに次を検証する。

- owner、repository、path、commit OIDが正しくencodeされ、ref名ではなくcommit OIDをqueryへ使う
- branch名が同じままcommit OIDだけ変わる遷移で、別のsourceを取得する
- commit OIDが欠落または不正なpage contextと、sender tab URLに一致しないmessageを拒否する
- 検証済みidentityからcommit OIDを含むimmutable blob permalinkを生成し、branch URLを評価用 `sourceUrl` に使わない
- percent-encode後の `sourceUrl` が2,048文字以下のASCII Python blob URLであることを検証し、2,048文字ちょうどと超過、長いpathを含める
- raw media typeとAPI version headerを送る
- UTF-8本文を返す正常系
- `404`、rate limit、server error、timeout、network errorの分類
- `Content-Length` 有無の両方で1 MiB超過を拒否し、chunked responseは超過時にcancelして追加chunkを読まない
- 非UTF-8、およびdirectoryなどraw本文ではないresponseを拒否する
- 同じimmutable page contextの同時取得を1requestへまとめる
- 初回失敗後の同じcontextで再試行でき、失敗したpromiseをcacheしない
- LRUの8entryと合計4 MiBそれぞれの境界で古いentryを破棄する

### 構文抽出の単体テスト

fixture全体と期待する候補codeを比較し、少なくとも次を含める。

- 単純なtop-level `def` とファイル末尾の定義
- 複数行signatureと戻り値annotation
- 複数decoratorを持つ `def` / `async def`
- instance method、`@classmethod`、`@staticmethod`
- decorated methodのcodeが最初のdecorator行を含め、全行の元indentを保つこと
- method本体のnested block、複数行文字列、内包表記
- nested functionとnested class methodを単独候補にしないこと
- syntax errorを含む定義だけを除外し、別の正常な定義は残すこと
- `@registry[name]` など未対応のPEP 614デコレータを、decoratorなしの関数として誤採用しないこと
- 候補直前のerror recoveryから切り離された `FunctionDefinition` を採用しないこと
- decorator由来ではないtop-level / class内の不正文の後にある正常な定義は採用できること
- Unicode識別子・文字列とCRLFでoffset、行番号、slice結果が一致すること
- parserが未対応の構文で誤った部分範囲を返さず候補なしへ倒れること

候補選出のheuristicは構文fixtureから分離する。getter除外や難易度分類のテストで、パーサー内部のnode名を直接参照しない。

候補選出では、既存評価契約に合わせてimmutable `sourceUrl` が2,048文字以下、codeが30,000 Unicode code point以下であることを必須とする。さらに候補code、immutable `sourceUrl`、固定field、最小の有効な回答を含むrequestを実際にJSON serializeし、64 KiBを超える定義は候補にしない。送信時はユーザーの実回答を含むrequestを再度serializeしてbyte数を検証する。URLとcodeの各上限、ASCII以外の複数byte文字、JSON escapeでbyte数が増える文字、64 KiBの直前と超過を単体テストする。

### 結合・配布テスト

- Background Workerがページcontextを受け、source取得と抽出を経て候補を返すmessage flow
- 候補を選ぶとトレーニングと同じ評価入力へcodeと同じcommitのimmutable `sourceUrl` が渡ること
- 回答中にbranchが移動しても、候補のcodeと `sourceUrl` のcommit OIDが変わらないこと
- 同一branch URLでcommit OIDがAからBへ変わるとページ変更を通知し、前の候補・対象コード・回答をresetしてBを再取得すること
- OID Aの遅延responseがOID Bのcurrent contextへ到着しても、context keyまたはrequest IDの不一致で表示しないこと
- 取得・解析error時に候補なしと障害を区別し、再試行方法を案内すること
- 本番extension buildにparserが含まれ、外部scriptを実行しないこと
- parser追加前後の `dist/extension` のbyte数と、代表fixture（小・中・上限付近）の解析時間を記録すること

処理時間とbundle sizeは端末やminifierに依存するため、この設計段階では根拠のない絶対値を合格条件にしない。実装PRで計測値を残し、UIを長時間占有する結果ならfile size上限またはparser実行境界を見直す。

## 9. 参照

- [MVP実装計画](implementation-plan.md)
- [プロダクト概要](product-overview.md)
- [Lezer Python grammar](https://www.npmjs.com/package/@lezer/python)
- [Lezer System Guide](https://lezer.codemirror.net/docs/guide/)
- [GitHub REST API: Repository contents](https://docs.github.com/en/rest/repos/contents)
- [GitHub REST APIのrate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
