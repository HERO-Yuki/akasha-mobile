# Akasha Mobile (iOS)

Dropbox の `/podcast` を参照するポッドキャスト風音声プレイヤー。
**0円運用**（無料Apple ID + Sideloadly、7日ごと再署名）を前提にした構成です。

## 機能

- Dropbox PKCE OAuth 接続（トークンは端末のSecure Storeに保存、自動リフレッシュ）
- Inbox / アーカイブ / お気に入り ビュー（`trash/` は一覧に表示しない）
- ストリーミング再生（一時リンク）・バックグラウンド再生・ロック画面コントロール
- 再生位置の記憶・レジューム、95%到達で「✓ 視聴済み」（App_036 準拠）
- **聴き終えたら自動でアーカイブへ移動**（トグルでOFF可）
- **一覧の左右スワイプで仕分け**（v0.2）。左＝送り出す（浅い／深いで2段）、右＝ひとつ戻す
- **移動はすべて「元に戻す」で取り消せる**（v0.2）
- **アーカイブ一括削除**: 選んだものだけ `trash/` へ移動（選ばなければ残る）
- 倍速（0.5x〜2.0x・ピッチ維持）、-15s/+30s、連続再生
- 失敗した移動は保留キューに積まれ、アプリに戻ったときに自動で再試行（v0.2）
- エラーは「コード + 原因 + 対処 + 生ログ」の4点で表示（v0.2）
- **署名期限のカウントダウン**（v0.3）。残り3日を切ると警告バーが出る

## 署名期限のカウントダウン（v0.3）

無料Apple IDの署名は7日で切れ、切れるとアプリが開けなくなる（データは消えない）。
Auto Refresh を有効にしていても、**その時刻に iPhone が PC から見えていなければ再署名は走らない**。
実際に 2026-08-24 に、Auto Refresh は ON のまま端末が検出されず期限切れになった。
突然使えなくなるのを防ぐため、アプリ内に残り時間を出す。

- **期限の出所は `embedded.mobileprovision` の `ExpirationDate`**（`src/signing.ts`）。
  日数を推測しない。Sideloadly が署名時に埋め込む本物の値を読む
- 残り **3日** を切ると警告バーを表示。自動再署名は期限の96時間前（4日前）に走るので、
  3日を切っている＝**自動再署名が一度は空振りしている**という意味になる
- 残り **1日** を切ると赤に変わる。タップすると対処方法が出る
- アプリ復帰（`AppState` active）のたびに読み直すので、再署名すれば自動で伸びる
- 未署名ビルド・シミュレータ・Expo Go では読めないので**何も出さない**
  （一度読めた値は AsyncStorage に控え、読めなかった回のフォールバックにする）

## スワイプの割り当て

浅い＝**56px** 以上、深い＝**140px** 以上。閾値を跨ぐたびに軽く振動し、
背景のラベルと色で「いま指を離すとどこへ行くか」が分かる。

| ビュー | ← 左（送り出す） | → 右（ひとつ戻す） |
|---|---|---|
| Inbox | 浅: アーカイブへ／深: **★ お気に入りへ** | — |
| アーカイブ | 浅: **★ お気に入りへ**／深: `trash` へ削除 | Inbox へ戻す |
| お気に入り | **アーカイブへ戻す** | **アーカイブへ戻す** |

規則は「**浅い＝そのビューで一番よく使う行き先、深い＝もう一段強い操作**」。
どの移動も直後のトーストから「元に戻す」で取り消せる（6秒間）。

お気に入りは終点で「送り出す」先が無いため、**左右どちらに引いてもアーカイブへ戻る**
（v0.2 では右だけに割り当てていたが、左に引いた人が「何も無い」と誤解したため v0.2.1 で両対応にした）。

各ビューには**初回だけ操作ガイドの1行**が出る。そのビューで一度スワイプすると
`settings.swipeHintDone` に記録されて以後は表示されない（画面の縦を占有し続けない）。

### ジェスチャの決めごと（v0.2.2 で作り直した）

縦スクロールと横スワイプが競合して行が途中で止まる問題があったため、次の4点を入れた。

1. **方向ロック** — 指を置いてから最初にはっきり動いた方向へ一度だけ倒し、指を離すまで変えない
   （縦: `|dy|>10 かつ |dy|>=|dx|` ／ 横: `|dx|>14 かつ |dx|>|dy|*1.4`）。判定がつくまでは保留する
2. **`onPanResponderTerminationRequest: () => false`** — 一度掴んだ横スワイプを
   `FlatList` のスクロールに横取りさせない。奪われると行が変位したまま取り残される
3. **スワイプ中は `scrollEnabled={false}`** — 縦横が同時に効いて両方中途半端になるのを防ぐ
4. **`useNativeDriver: false` に統一** — 同じ `Animated.Value` に対して
   JS の `setValue()` とネイティブ駆動アニメーションを混ぜると値が同期しなくなり、
   **行が画面上で変位したまま固まる**。ドラッグ追従に `setValue` を使う以上、駆動側も JS に揃える

あわせて、方向判定に使った移動量（`originRef`）を差し引いてから追従させ、掴んだ瞬間に
行が 14px ジャンプするのをなくした。発動アニメーション中も背景ラベルを出したままにしている。

## v0.2 の変更

1. **上部のロゴ行を廃止**。タブ行に「接続解除」を畳んで1行ぶんの高さを取り戻した。
2. **2段階スワイプ**。`PanResponder`（React Native 標準）で実装しており、
   `react-native-gesture-handler` などのジェスチャライブラリは増やしていない
   （CIビルドを壊さないため）。触覚だけ `expo-haptics` を追加した。
3. **「アーカイブ移動に失敗」の根治**。原因は expo-secure-store の既定保護レベル
   `WHEN_UNLOCKED` で、**画面ロック中はトークンを読み出せない**こと。聴き終わるのは
   たいていロック中なので、その瞬間の自動アーカイブが失敗していた。
   `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` に変更し、旧トークンは起動時に保存し直す。
   あわせて (a) 移動後の新パスをアプリ内に反映（従来は古いパスのままで、続く操作が
   `from_lookup/not_found` になった）、(b) `too_many_write_operations` / 429 の自動再試行、
   (c) 失敗ぶんの保留キューを追加。
4. **エラー表示の刷新**。`src/errors.ts` が Dropbox の `error_summary` を日本語の原因と
   対処に翻訳する。詳細欄は長押しでコピーでき、そのまま改修の材料にできる。
5. **押した手応え**（桜井流レビューのレシピ2）。全 `Pressable` に押下スタイル、
   再生タップ時の即時ハイライトと「読み込み中…」表示、連続再生の終端通知、
   操作の要所で触覚フィードバック。
6. **一括削除モーダルの反転を解消**。従来は `☑`＝削除・`★`＝残すで意味が逆だった。
   既定を「全部残す」にし、消したいものだけ選ぶ形に。`すべて選択` も用意した。
   お気に入りへの退避はスワイプに移したので、このモーダルは削除専用に戻した。

UI/UX の診断は `docs/UIUXレビュー_桜井流_20260807.md`（`sakurai-ui-ux` スキル準拠）。
レシピ3（レイアウトの配り直し）と次点の項目は未着手。

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
App.tsx                 # UI・再生・スワイプ操作・一括削除フロー・エラー詳細モーダル
src/config.ts           # App key・フォルダ名・視聴済み閾値
src/dropbox.ts          # OAuth(PKCE+refresh) / list_folder / move_v2 / temporary_link
src/errors.ts           # エラーの構造化と「原因・対処」への翻訳
src/signing.ts          # 署名期限（embedded.mobileprovision の ExpirationDate）
src/store.ts            # 再生位置・設定・保留中の移動（AsyncStorage）
src/theme.ts            # カラー（#E8884D アクセント）
.github/workflows/build-ios-unsigned.yml  # 未署名IPAビルド
```
