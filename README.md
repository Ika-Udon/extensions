# TurboWarp 拡張機能ライブラリ

GitHub Pagesで公開する、TurboWarp拡張機能の静的な配布サイトです。Modrinth風のモダンなUIを採用しています。

## GitHub Pagesで公開する

1. このフォルダをGitHubのリポジトリへアップロードします。
2. リポジトリの **Settings → Pages** を開きます。
3. **Build and deployment** の Source を **Deploy from a branch** にします。
4. 公開するブランチ（通常は `main`）とフォルダ **/(root)** を選んで保存します。

反映には数分かかることがあります。以後はGitHub上でファイルを編集して保存すると、Pagesのサイトも自動的に更新されます。

## 拡張機能を追加・更新する

最新のJavaScriptファイルだけを `extensions/` に置き、`data/extensions.json` の `extensions` 配列に項目を追加または更新します。

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

- `id` は英小文字・数字・ハイフンで、ほかの拡張機能と重複しない値にします。
- `file` はリポジトリ直下からのファイルパスです。
- バージョンアップ時は、JSファイルを最新版で上書きし、`version`、`updatedAt`、`changelog` を更新します。旧JSファイルは残しません。
- JSONの文字列内に改行を入れるときは `\n` と書きます。末尾の項目の後にカンマを付けないでください。

## ローカルで確認する

`fetch` を使うため、`index.html` をファイルとして直接開くのではなく、ローカルWebサーバーから開いてください。たとえばVS CodeのLive Serverなどを利用できます。
