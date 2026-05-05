# 今日のスケジュール

本番 URL: <https://one-day-schedule.waterada.workers.dev/>

子ども向けの 1 日タイムライン PWA。タスクを作ってタイムラインの開始・終了スロットをタップして配置する。データは Cloudflare Durable Object に保存し、`localStorage` にもキャッシュを持つ (オフライン継続用)。

iPhone でホーム画面に追加すると、PWA としてアプリのように動く。

## アーキテクチャ

```
ブラウザ ──HTTPS──▶ Cloudflare Worker ──▶ Durable Object (固定 ID "daughter")
                          │                       │
                          ├─ /api/state          └─ state.storage に
                          │     GET / PUT             {tasks, placed, version,
                          │  (Bearer SHARED_SECRET)    updatedAt} を 1 キー保持
                          │
                          └─ それ以外は public/ 配下を [assets] が配信
```

- 静的アセット (HTML / sw.js / icons) と API は **同一 Worker / 同一オリジン**
- 認証は固定の **`SHARED_SECRET`** を `Authorization: Bearer` で送るだけ。利用者が娘 1 人なので最小構成
- 楽観ロック: PUT に `baseVersion` を載せ、サーバ側で不一致なら 409 を返してクライアントが取り込み直す
- localStorage には `tasks` `placed` `serverPassphrase` `serverVersion` を保持

## ファイル構成

```
public/                     Worker [assets] が配信する静的ファイル
  index.html                  本体 (HTML / CSS / JS 全部入り)
  manifest.json               Web App Manifest
  sw.js                       Service Worker (/api/* はパススルー)
  version.js                  APP_VERSION 定義 (キャッシュ世代)
  icons/                      PWA アイコン
src/                        Worker / Durable Object のソース (TypeScript)
  index.ts                    エントリ。/api/* は認証 → DO に転送、それ以外は ASSETS へ
  schedule-do.ts              DO クラス。state.storage で楽観ロック付き読み書き
wrangler.toml               Wrangler 設定 (assets = ./public, DO binding, migrations)
package.json                npm scripts (dev / deploy / typecheck)
tsconfig.json               TypeScript 設定
make_icons.py               アイコン再生成スクリプト (Pillow)
.dev.vars                   ローカル開発用の SHARED_SECRET (Git 管理外)
```

## ローカル開発

### 前提

- Node 22 系 (Volta などで管理)
- Docker (WSL Ubuntu 20.04 など glibc 2.31 環境では `wrangler dev` がそのまま起動できないため、Docker 経由で実行する)
- 初回のみ `npm install`

### 開発サーバ起動

```bash
npm run dev
```

これは内部的に以下を実行する:

```bash
docker run --rm -it -v "$PWD:/app" -w /app -p 8787:8787 \
  -u $(id -u):$(id -g) -e HOME=/tmp \
  node:22-bookworm-slim \
  npx wrangler dev --ip 0.0.0.0 --port 8787 --show-interactive-dev-session=false
```

ホスト側 OS に十分新しい glibc (2.35+) があれば `npm run dev:host` (素の `wrangler dev`) も使える。

ブラウザで http://localhost:8787/ を開く。初回は **合言葉モーダル** が表示されるので、`.dev.vars` に書いた `SHARED_SECRET` を入力。

### `.dev.vars` (ローカル専用)

開発時のみ参照される秘密ファイル (Git 管理外)。例:

```
SHARED_SECRET="dev-only-test-secret-12345678"
```

ここに書いた値は本番には反映されない。本番の secret 設定は後述。

### DO のローカルデータをリセット

ローカル DO の状態は `.wrangler/state/` 配下にファイルで残る。最初からやり直したいときは:

```bash
rm -rf .wrangler/state
```

### 型チェック

```bash
npm run typecheck
```

## 本番デプロイ

### 1. Cloudflare アカウント作成 (初回のみ)

https://dash.cloudflare.com/sign-up でメアド + パスワード登録。Workers Free プランで足りる。クレジットカード不要。

### 2. wrangler ログイン

```bash
npx wrangler login
```

ブラウザが OAuth ページを開く → Allow。

### 3. SHARED_SECRET の登録

長いランダム文字列を生成して Cloudflare の Secret として登録する:

```bash
SECRET=$(openssl rand -base64 24 | tr -d '\n')
echo "$SECRET"        # ← これは娘の端末で 1 回だけ入力するのでメモする
echo -n "$SECRET" | npx wrangler secret put SHARED_SECRET
```

Secret は Cloudflare 側に暗号化保存され、ローカルファイルには残らない (1Password などにメモしておく)。

### 4. デプロイ

```bash
npx wrangler deploy
```

完了すると本番 URL `https://one-day-schedule.waterada.workers.dev/` で公開される。

> 初回デプロイ前に、Cloudflare ダッシュボードの **Compute (Workers) → Workers & Pages** を一度ブラウザで開いて workers.dev サブドメインを確定させておくこと。これをやらないと `code 10063 (You need a workers.dev subdomain)` エラーで `wrangler deploy` が失敗する。

### Secret を回転させたいとき

`SHARED_SECRET` を再生成して登録し直す:

```bash
NEW_SECRET=$(openssl rand -base64 24 | tr -d '\n')
echo -n "$NEW_SECRET" | npx wrangler secret put SHARED_SECRET
# 反映は数秒〜十数秒
```

娘の端末側ではアプリが 401 を受けて合言葉モーダルが再表示される (開発者ツールで `localStorage.removeItem('serverPassphrase')` してリロードする方が早い場合もある)。

### コードを更新したとき

```bash
npx wrangler deploy
```

静的アセットも自動的にアップロードされる。Service Worker 経由のキャッシュを更新したい場合は `public/version.js` の `APP_VERSION` を上げてからデプロイ (上げないと旧キャッシュが残るブラウザがある)。

```js
const APP_VERSION = '1.1.0';  // → '1.2.0' など
```

## 娘の端末セットアップ

1. <https://one-day-schedule.waterada.workers.dev/> を **Safari** で開く (Chrome ではホーム追加できない)
2. 共有ボタン → **ホーム画面に追加**
3. アイコンから起動 → 合言葉モーダルが出るので、上記 3 で生成した SECRET を 1 回だけ入力
4. 以降は普通に使うだけ。データは Cloudflare に保存され、別端末でも同じ合言葉で同期できる

## キャッシュ・データの整理メモ

- `public/version.js` の `APP_VERSION` を上げる: クライアントの Service Worker キャッシュ世代を更新
- `wrangler secret put SHARED_SECRET`: サーバ側合言葉を更新 (端末側は再入力が必要になる)
- 端末 DevTools で `localStorage.clear()`: 端末ローカルキャッシュをリセット

## アイコンを作り直す

`make_icons.py` を編集して再実行:

```bash
pip install Pillow
python3 make_icons.py
```

`public/icons/` 配下の PNG が上書きされる。

## ホスティング履歴 (参考)

以前は GitHub Pages (`https://waterada.github.io/one-day-schedule/`) で `localStorage` のみで運用していた。サーバ保存への移行に伴い Cloudflare Workers に変更。
