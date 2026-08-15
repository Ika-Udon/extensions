# TurboWarp 拡張機能ライブラリ

GitHub Pagesで公開する、TurboWarp拡張機能の静的な配布サイトです。

## GitHub Pagesで公開する

1. このフォルダをGitHubのリポジトリへアップロードします。
2. リポジトリの **Settings → Pages** を開きます。
3. **Build and deployment** の Source を **Deploy from a branch** にします。
4. 公開するブランチ（通常は `main`）とフォルダ **/(root)** を選んで保存します。

反映には数分かかることがあります。以後はGitHub上でファイルを編集して保存すると、Pagesのサイトも自動的に更新されます。

## 拡張機能を追加・更新する

1. **JavaScriptファイルを配置**: 最新のJSファイルを `extensions/` フォルダに置きます（例: `extensions/my-extension.js`）。
2. **個別JSONファイルを作成**: `data/extensions/` フォルダ内に拡張機能IDと同じ名前のJSONファイル（例: `data/extensions/my-extension.json`）を作成します。
3. **インデックスに登録**: `data/index.json` の `extensions` 配列に拡張機能のID（`"my-extension"`）を追加します。

### 個別JSONファイル（`data/extensions/my-extension.json`）の書き方:
```json
{
  "id": "my-extension",
  "name": "拡張機能の名前",
  "author": "作成者名",
  "category": "ユーティリティ",
  "tags": ["TurboWarp", "便利", "軽量"],
  "summary": "一覧に表示する短い説明",
  "description": "詳細ページに表示する説明。\n改行も使えます。",
  "file": "extensions/my-extension.js",
  "version": "1.0.0",
  "updatedAt": "2026-08-16",
  "changelog": [
    {
      "version": "1.0.0",
      "date": "2026-08-16",
      "changes": ["最初の公開"]
    }
  ]
}
```

- `id` は英小文字・数字・ハイフンで、他の拡張機能と重複しない値にします。
- `file` はリポジトリ直下からのファイルパスです。
- バージョンアップ時は、JSファイルと該当の `data/extensions/<id>.json` のみを更新します。

## ローカルで確認する

`fetch` を使うため、`index.html` をファイルとして直接開くのではなく、ローカルWebサーバーから開いてください。たとえばVS CodeのLive Serverなどを利用できます。
