# Akasha Mobile (iOS)

Dropbox の `/podcast` を参照するポッドキャスト風音声プレイヤー。
**0円運用**（無料Apple ID + Sideloadly、7日ごと再署名）を前提にした構成です。

## 機能

- Dropbox PKCE OAuth 接続（トークンは端末のSecure Storeに保存、自動リフレッシュ）
- Inbox / アーカイブ / お気に入り ビュー（`trash/` は一覧に表示しない）
- ストリーミング再生（一時リンク）・バックグラウンド再生・ロック画面コントロール
- 再生位置の記憶・レジューム、95%到達で「✓ 視聴済み」（App_036 準拠）
- **聴き終えたら自動でアーカイブへ移動**（トグルでOFF可）
- **アーカイブ一括削除**: 一覧から除外(★)したものは `favorites/` へ、
  それ以外は `trash/` へ移動して一覧から消える
- 倍速（0.5x〜2.0x・ピッチ維持）、-15s/+30s、連続再生

フォルダ名は `src/config.ts` の定数で変更可能（既定は App_036 互換の
`archives` / `trash` / `favorites`）。

---

## セットアップ（初回のみ・すべて無料）

### 1. Dropbox アプリを登録（5分）

1. https://www.dropbox.com/developers/apps → **Create app**
2. **Scoped access** → **Full Dropbox** → 名前は例: `akasha-player`
3. **Permissions** タブで以下にチェックして **Submit**:
   `account_info.read` / `files.metadata.read` / `files.content.read` / `files.content.write`
4. **Settings** タブ → OAuth 2 → **Redirect URIs** に `akasha://oauth` を追加
5. 同じ画面の **App key** をコピーし、`src/config.ts` の
   `DROPBOX_APP_KEY = 'PASTE_YOUR_APP_KEY_HERE'` に貼る

※ App key は秘密情報ではありません（PKCEフローのため App secret は不使用）。
公開リポジトリに入れても問題ありません。

### 2. GitHub リポジトリを作って push

```bash
cd App_051_Akasha/mobile
git init
git add .
git commit -m "Akasha mobile v0.1"
# GitHubで空リポジトリ（publicなら Actions 無制限・無料）を作ってから:
git remote add origin https://github.com/<あなたのID>/akasha-mobile.git
git push -u origin main
```

private リポジトリでも動きますが、無料枠は macOS ランナー換算で
月200分（実ビルド8〜13回分）です。public なら無制限。

### 3. IPA をビルド（クラウド・Mac不要）

GitHub のリポジトリページ → **Actions** タブ →
**Build unsigned iOS IPA** → **Run workflow**。
15〜25分で完了し、**Artifacts** に `Akasha-unsigned-ipa` ができるのでダウンロード・解凍。

### 4. iPhone にインストール（Sideloadly）

1. Windows に https://sideloadly.io/ をインストール（無料）
2. iPhone を USB で PC に接続
3. Sideloadly に `Akasha-unsigned.ipa` をドラッグ → Apple ID を入力 → **Start**
   - Apple ID は普段のものでOK（開発用に別IDを作っても可）
4. iPhone 側: 設定 → 一般 → **VPNとデバイス管理** → 自分のApple IDを「信頼」
5. ホーム画面の Akasha を起動 → **Dropbox に接続** → 完了

### 5. 7日ごとの更新（無料Apple IDの制約）

- 期限が切れたらアプリを開けなくなる（データは消えない）
- Sideloadly で同じ IPA をもう一度インストールすれば再開
  （**Auto Refresh** 機能を有効にすると、iPhoneが同じWi-Fi/USB接続時に自動更新）
- 無料Apple IDは**同時3アプリまで**・App ID作成は週10個まで

---

## 開発メモ

- コード変更後は push → Actions 再実行 → 新IPAをSideloadlyで上書きインストール
- ローカルでUI確認したい場合: `npm install && npx expo start` → Expo Go
  （ただし expo-audio のロック画面制御と OAuth リダイレクトは開発ビルドでのみ完全動作）
- 将来 App Store / TestFlight に移行する場合は Apple Developer Program（$99/年）
  に登録し、`eas build` に切り替えるだけ（コード変更不要）

## 構成

```
App.tsx                 # UI・再生・一括削除フロー
src/config.ts           # App key・フォルダ名・視聴済み閾値
src/dropbox.ts          # OAuth(PKCE+refresh) / list_folder / move_v2 / temporary_link
src/store.ts            # 再生位置・設定（AsyncStorage）
src/theme.ts            # カラー（#E8884D アクセント）
.github/workflows/build-ios-unsigned.yml  # 未署名IPAビルド
```
