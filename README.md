# 今日のスケジュール

子ども向けの 1 日タイムラインアプリ。タスクを作って、タイムラインの開始・終了スロットをタップして配置する。データは `localStorage` に保存。

iPhone でホーム画面に置くと、PWA としてアプリのように動く。

## ファイル構成

```
schedule.html         本体（HTML / CSS / JS 全部入り）
manifest.json         Web App Manifest
sw.js                 Service Worker（オフライン対応）
icons/
  icon-180.png        apple-touch-icon
  icon-192.png        manifest 用
  icon-512.png        manifest 用
  icon-maskable-512.png  Android maskable 用
make_icons.py         アイコン再生成スクリプト（Pillow 使用）
```

## ローカルで動かす

`file://` ではなく HTTP サーバ経由で開く必要がある（Service Worker が登録できないため）。

```bash
python3 -m http.server 8000
# → http://localhost:8000/schedule.html
```

## GitHub Pages デプロイ

1. リポジトリにコミット & push
2. GitHub の該当リポジトリ → Settings → Pages
3. Source を `main` ブランチ / `/ (root)` に設定
4. 数分後、以下の URL で公開される
   ```
   https://waterada.github.io/one-day-schedule/schedule.html
   ```

GitHub Pages は HTTPS で配信されるため、Service Worker が動作する。

## iPhone で「ホームに追加」する

1. iPhone の **Safari** で上記 URL を開く（Chrome ではダメ）
2. 共有ボタン（□↑）→ **「ホーム画面に追加」**
3. ホーム画面のアイコンから起動するとアドレスバー・タブが消えてアプリのように全画面表示される
4. 機内モードでもキャッシュから起動可能

### 確認ポイント

- ホーム画面に専用アイコンが表示される
- 起動時に Safari の UI が出ない（standalone モード）
- オフラインでも開ける
- ステータスバーは通常表示（`apple-mobile-web-app-status-bar-style: default`）

## アイコンを作り直す

デザインを変えたいときは `make_icons.py` を編集して再実行。

```bash
pip install Pillow
python3 make_icons.py
```

`icons/` 配下の PNG が上書きされる。

## キャッシュ更新

`sw.js` 上部の `CACHE_VERSION` を上げると、次回アクセス時に新しい Service Worker がインストールされ、古いキャッシュが破棄される。HTML/CSS/JS を更新したら忘れずにバージョンを上げる。

```js
const CACHE_VERSION = 'v1';  // → 'v2' など
```
