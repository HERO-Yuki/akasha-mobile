/**
 * Akasha — クラウド参照 音声プレイヤー（iOS / Expo）
 *
 * - Dropbox /podcast を参照（App_036 AudioInbox 運用準拠）
 * - Inbox / アーカイブ / お気に入り ビュー（trash は非表示）
 * - 聴き終えたら自動でアーカイブへ移動（失敗しても保留キューに積んで自動再試行）
 * - 一覧の左右スワイプで仕分け。左＝送り出す（浅い／深いで2段）、右＝ひとつ戻す
 * - 移動はすべて「元に戻す」付きトーストで取り消せる
 * - バックグラウンド再生・ロック画面コントロール（expo-audio）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, AppState, FlatList, Modal, PanResponder,
  Pressable, RefreshControl, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, View, ViewStyle,
} from 'react-native';
import type { PanResponderInstance } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import * as WebBrowser from 'expo-web-browser';
import * as Haptics from 'expo-haptics';
import { makeRedirectUri, useAuthRequest, exchangeCodeAsync } from 'expo-auth-session';
import {
  DROPBOX_APP_KEY, LISTENED_RATIO, ARCHIVE_DIR, FAVORITES_DIR, TRASH_DIR,
} from './src/config';
import { C } from './src/theme';
import {
  DISCOVERY, Track, MovedMeta, listPodcast, getTemporaryLink, moveToDir, moveToPath,
  moveToTrash, saveTokens, hasRefreshToken, clearTokens, migrateKeychainAccessibility,
} from './src/dropbox';
import { DB, SortKey, loadDB, persist, queueMove, remapPosition } from './src/store';
import { ErrorInfo, describeError } from './src/errors';
import Constants from 'expo-constants';
import { loadSigningExpiry, fmtExpiry, remainingLabel } from './src/signing';

const APP_VERSION = Constants.expoConfig?.version ?? '?';

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_URI = makeRedirectUri({ scheme: 'akasha', path: 'oauth' });
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];
type ViewName = 'inbox' | 'archive' | 'favorite';

/* ---------- スワイプの割り当て ----------
 * 左（右→左）＝送り出す。浅い＝そのビューで一番よく使う行き先、深い＝もう一段強い操作。
 * 右（左→右）＝ひとつ戻す。
 */
/** 署名の残りがこれを切ったら警告を出す。自動再署名は期限の4日前に走るので、
 *  3日を切っている＝自動再署名が一度は空振りしている、という意味になる */
const SIGN_WARN_DAYS = 3;

const SHALLOW = 56;   // これを超えたら浅い側が発動
const DEEP = 140;     // これを超えたら深い側が発動

type Tone = 'normal' | 'fav' | 'danger';
interface SwipeAction {
  dest: string;             // 移動先ディレクトリ（'' は /podcast 直下＝Inbox）
  view: Track['view'];      // 移動後に属するビュー
  label: string;            // スワイプ中に出す行き先
  done: string;             // 完了トーストの文言
  tone: Tone;
}
interface SwipeSet {
  shallow?: SwipeAction;
  deep?: SwipeAction;
  right?: SwipeAction;
}

const A_ARCHIVE: SwipeAction = {
  dest: ARCHIVE_DIR, view: 'archive', label: 'アーカイブへ', done: 'アーカイブへ移動しました', tone: 'normal',
};
const A_FAVORITE: SwipeAction = {
  dest: FAVORITES_DIR, view: 'favorite', label: '★ お気に入りへ', done: '★ お気に入りへ移動しました', tone: 'fav',
};
const A_TRASH: SwipeAction = {
  dest: TRASH_DIR, view: 'trash', label: `${TRASH_DIR} へ削除`, done: '削除しました', tone: 'danger',
};
const A_INBOX: SwipeAction = {
  dest: '', view: 'inbox', label: 'Inbox へ戻す', done: 'Inbox へ戻しました', tone: 'normal',
};
/** お気に入りは終点なので「送り出す」先が無い。左右どちらに引いてもアーカイブへ戻す */
const A_ARCHIVE_BACK: SwipeAction = {
  dest: ARCHIVE_DIR, view: 'archive', label: 'アーカイブへ戻す', done: 'アーカイブへ戻しました', tone: 'normal',
};

const SWIPE: Record<ViewName, SwipeSet> = {
  inbox:    { shallow: A_ARCHIVE,  deep: A_FAVORITE },
  archive:  { shallow: A_FAVORITE, deep: A_TRASH, right: A_INBOX },
  favorite: { shallow: A_ARCHIVE_BACK, right: A_ARCHIVE_BACK },
};

/** 並び順。ボタンには短い方を出し、選択肢には説明つきの方を出す */
const SORT_SHORT: Record<SortKey, string> = { new: '新着', old: '古い', name: '名前' };
const SORT_LONG: Record<SortKey, string> = {
  new: '新しい順',
  old: '古い順',
  name: '名前順（かな始まりのみ期待通り）',
};

/** 各ビューで一度スワイプするまで出す操作ガイド（使ったら消える） */
const SWIPE_HINT: Record<ViewName, string> = {
  inbox: '行を左にスワイプ → 浅く: アーカイブへ ／ 深く: ★ お気に入りへ',
  archive: '左に浅く: ★ お気に入り ／ 深く: 削除　　右: Inbox へ戻す',
  favorite: '左右どちらかにスワイプ → アーカイブへ戻す',
};

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '–:––';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

const seekWidth = { current: 1 };

/** 押した手応え。全 Pressable に使う */
const press =
  (base: ViewStyle | ViewStyle[], pressedStyle: ViewStyle = { opacity: 0.55 }) =>
  ({ pressed }: { pressed: boolean }) =>
    [base, pressed && pressedStyle] as ViewStyle[];

/* ---------- 2段階スワイプ（依存ライブラリなし: PanResponder） ---------- */

function SwipeableRow({
  actions,
  onAction,
  onSwipeActive,
  children,
}: {
  actions: SwipeSet;
  onAction: (a: SwipeAction) => void;
  onSwipeActive: (active: boolean) => void;
  children: React.ReactNode;
}) {
  const tx = useRef(new Animated.Value(0)).current;
  const [dragging, setDragging] = useState(false);
  const [dir, setDir] = useState(0);                       // -1: 左, 1: 右
  const [armed, setArmed] = useState<SwipeAction | null>(null);

  // PanResponder は作り直さない。最新の値は ref 経由で読む
  const actRef = useRef(actions);
  const onActionRef = useRef(onAction);
  const onActiveRef = useRef(onSwipeActive);
  const armedRef = useRef<SwipeAction | null>(null);
  /** このタッチを縦スクロールと横スワイプのどちらに使うか。一度決めたら指を離すまで変えない */
  const lockRef = useRef<'none' | 'h' | 'v'>('none');
  /** 方向判定に使った移動量。これを引かないと掴んだ瞬間に行がその分ジャンプする */
  const originRef = useRef(0);
  actRef.current = actions;
  onActionRef.current = onAction;
  onActiveRef.current = onSwipeActive;

  // 画面から外れるときにアニメーションを止める（途中の値で固まらせない）
  useEffect(() => () => { tx.stopAnimation(); }, [tx]);

  const enabled = !!(actions.shallow || actions.deep || actions.right);

  const panRef = useRef<PanResponderInstance | null>(null);
  if (!panRef.current) {
    /** 指を離した／横取りされたときの後始末。必ずここを通して 0 に戻す */
    const settle = (dx: number) => {
      lockRef.current = 'none';
      const fire = armedRef.current;
      armedRef.current = null;
      setArmed(null);
      setDir(0);
      onActiveRef.current(false);
      if (fire) {
        // 背景は出したまま送り出す（先に消すと何が起きたのか分からない）
        Animated.timing(tx, {
          toValue: dx < 0 ? -520 : 520,
          duration: 140,
          useNativeDriver: false,
        }).start(() => {
          onActionRef.current(fire);
          tx.setValue(0);
          setDragging(false);
        });
      } else {
        Animated.spring(tx, {
          toValue: 0, useNativeDriver: false, bounciness: 0, speed: 20,
        }).start(() => setDragging(false));
      }
    };

    panRef.current = PanResponder.create({
      // 指を置き直すたびに方向判定をやり直す
      onStartShouldSetPanResponderCapture: () => {
        lockRef.current = 'none';
        return false;
      },
      onMoveShouldSetPanResponder: (_e, g) => {
        const a = actRef.current;
        if (!a.shallow && !a.deep && !a.right) return false;
        if (lockRef.current === 'v') return false;   // 縦と決めたらこのタッチ中は横を取らない
        if (lockRef.current === 'h') return true;
        const adx = Math.abs(g.dx);
        const ady = Math.abs(g.dy);
        // 先にはっきり動いた方へ一度だけ倒す。どちらとも言えない間は保留する
        if (ady > 10 && ady >= adx) { lockRef.current = 'v'; return false; }
        if (adx > 14 && adx > ady * 1.4) { lockRef.current = 'h'; return true; }
        return false;
      },
      // 一度掴んだらリストのスクロールに渡さない（途中で奪われると行が取り残される）
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (_e, g) => {
        originRef.current = g.dx;
        setDragging(true);
        onActiveRef.current(true);
      },
      onPanResponderMove: (_e, g) => {
        const a = actRef.current;
        const dx = g.dx - originRef.current;
        const hasLeft = !!(a.shallow || a.deep);
        const hasRight = !!a.right;
        // 行き先が無い方向は抵抗をかけて「ここには何も無い」と伝える
        const resist = (dx < 0 && !hasLeft) || (dx > 0 && !hasRight);
        tx.setValue(resist ? dx / 4 : dx);
        setDir(dx === 0 ? 0 : dx < 0 ? -1 : 1);

        let next: SwipeAction | null = null;
        if (dx < 0 && hasLeft) {
          if (-dx >= DEEP && a.deep) next = a.deep;
          else if (-dx >= SHALLOW) next = a.shallow ?? a.deep ?? null;
        } else if (dx > 0 && hasRight && dx >= SHALLOW) {
          next = a.right!;
        }
        if (next !== armedRef.current) {
          armedRef.current = next;
          setArmed(next);
          if (next) {
            Haptics.impactAsync(
              next.tone === 'danger'
                ? Haptics.ImpactFeedbackStyle.Medium
                : Haptics.ImpactFeedbackStyle.Light,
            ).catch(() => {});
          }
        }
      },
      onPanResponderRelease: (_e, g) => settle(g.dx - originRef.current),
      onPanResponderTerminate: () => settle(0),
    });
  }
  const pan = panRef.current;

  if (!enabled) return <>{children}</>;

  // 左スワイプ中は右端に、右スワイプ中は左端に行き先を出す
  const leftPending = dir < 0 ? armed ?? actions.shallow ?? actions.deep ?? null : null;
  const rightPending = dir > 0 ? armed ?? actions.right ?? null : null;
  const shown = armed;
  const hint =
    dir < 0 && actions.deep && armed !== actions.deep
      ? `もっと引くと ${actions.deep.label}`
      : null;

  return (
    <View>
      {dragging && (
        <View style={[s.swipeBg, shown ? toneBox[shown.tone] : null]} pointerEvents="none">
          <Text style={[s.swipeBgText, rightPending && shown ? toneText[shown.tone] : null]}>
            {rightPending ? rightPending.label : ''}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[s.swipeBgText, leftPending && shown ? toneText[shown.tone] : null]}>
              {leftPending ? leftPending.label : ''}
            </Text>
            {hint && <Text style={s.swipeSub}>{hint}</Text>}
          </View>
        </View>
      )}
      <Animated.View style={{ transform: [{ translateX: tx }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

export default function App() {
  /* ---------- auth ---------- */
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: DROPBOX_APP_KEY,
      scopes: [],
      redirectUri: REDIRECT_URI,
      usePKCE: true,
      extraParams: { token_access_type: 'offline' },
    },
    DISCOVERY,
  );

  useEffect(() => {
    migrateKeychainAccessibility().finally(() => {
      hasRefreshToken().then(setAuthed);
    });
  }, []);

  useEffect(() => {
    if (response?.type !== 'success' || !request?.codeVerifier) return;
    (async () => {
      try {
        const token = await exchangeCodeAsync(
          {
            clientId: DROPBOX_APP_KEY,
            code: response.params.code,
            redirectUri: REDIRECT_URI,
            extraParams: { code_verifier: request.codeVerifier! },
          },
          DISCOVERY,
        );
        await saveTokens({
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          expires_in: token.expiresIn,
        });
        setAuthed(true);
      } catch (e) {
        Alert.alert('接続エラー', String(e));
      }
    })();
  }, [response]);

  /* ---------- 通知（トースト / エラー詳細） ---------- */
  const [errModal, setErrModal] = useState<{ title: string; info: ErrorInfo } | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, undo?: () => void) => {
    setToast({ msg, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), undo ? 6000 : 2600);
  }, []);

  /* ---------- library ---------- */
  const [db, setDb] = useState<DB | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [view, setView] = useState<ViewName>('inbox');
  const [loading, setLoading] = useState(false);
  // 横スワイプ中はリストの縦スクロールを止める（同時に効くと両方が中途半端になる）
  const [swiping, setSwiping] = useState(false);
  // サイドロード署名の期限（無料Apple IDは7日で切れる）
  const [expiry, setExpiry] = useState<Date | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const handleSwipeActive = useCallback((a: boolean) => setSwiping(a), []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDB().then(setDb);
    loadSigningExpiry().then(setExpiry);
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
  }, []);

  /** 移動に失敗して溜まっているぶんを片付ける。戻り値は成功件数 */
  const flushPending = useCallback(async (): Promise<number> => {
    const d = await loadDB();
    if (!d.pending.length) return 0;
    const remaining: typeof d.pending = [];
    let done = 0;
    for (const p of d.pending) {
      try {
        const meta = await moveToDir({ pathLower: p.pathLower, name: p.name }, p.dest);
        remapPosition(d, p.pathLower, meta.pathLower);
        done++;
      } catch (e) {
        const info = describeError(e);
        // 元ファイルが無い＝すでに移動済み。キューから外してよい
        if (info.kind === 'gone') { done++; continue; }
        remaining.push({ ...p, tries: p.tries + 1, lastError: info.code });
      }
    }
    d.pending = remaining;
    persist();
    setDb({ ...d });
    return done;
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await flushPending().catch(() => 0);
      setTracks(await listPodcast());
    } catch (e) {
      const info = describeError(e);
      setError(`${info.cause}（${info.code}）`);
      setErrModal({ title: '一覧の取得に失敗', info });
    } finally {
      setLoading(false);
    }
  }, [flushPending]);

  useEffect(() => {
    if (authed) reload();
  }, [authed, reload]);

  // アプリに戻ってきたら、ロック中に失敗した移動を自動で片付ける
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      setNowMs(Date.now());
      loadSigningExpiry().then(setExpiry);   // 再署名されていれば期限が伸びている
      flushPending()
        .then((n) => { if (n > 0) { showToast(`保留していた移動 ${n}件を完了しました`); reload(); } })
        .catch(() => {});
    });
    return () => sub.remove();
  }, [flushPending, reload, showToast]);

  const sortKey: SortKey = db?.settings.sort?.[view] ?? 'new';
  const visible = useMemo(() => {
    const list = tracks.filter((t) => t.view === view);
    const byTime = (a: Track, b: Track) =>
      (a.serverModified || '').localeCompare(b.serverModified || '');
    if (sortKey === 'old') return list.sort(byTime);
    // 名前順: 漢字は読みが分からないので文字コード順になる（かな始まりだけ期待通り）
    if (sortKey === 'name') return list.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return list.sort((a, b) => byTime(b, a));
  }, [tracks, view, sortKey]);
  const counts = useMemo(() => {
    const c = { inbox: 0, archive: 0, favorite: 0 };
    for (const t of tracks) if (t.view !== 'trash') c[t.view as ViewName]++;
    return c;
  }, [tracks]);

  /** 移動が成功したら、アプリ内のパスも新しいものに差し替える */
  const applyMoved = useCallback((oldPath: string, meta: MovedMeta, nextView: Track['view']) => {
    setTracks((prev) =>
      prev.map((x) =>
        x.pathLower === oldPath
          ? { ...x, view: nextView, name: meta.name, pathLower: meta.pathLower, pathDisplay: meta.pathDisplay }
          : x,
      ),
    );
  }, []);

  /** そのビューで一度スワイプしたら操作ガイドを引っ込める */
  const markSwipeUsed = useCallback((v: ViewName) => {
    loadDB().then((d) => {
      if (d.settings.swipeHintDone[v]) return;
      d.settings.swipeHintDone[v] = true;
      persist();
      setDb({ ...d });
    });
  }, []);

  /* ---------- スワイプ1回ぶんの仕分け（取り消し付き） ---------- */
  const runAction = useCallback(
    async (t: Track, act: SwipeAction) => {
      const from = t.pathLower;
      const prevView = t.view;
      // 先に画面から消す（楽観的更新）。失敗したら戻す
      setTracks((prev) => prev.map((x) => (x.pathLower === from ? { ...x, view: act.view } : x)));
      try {
        const meta = await moveToDir({ pathLower: from, name: t.name }, act.dest);
        const d = await loadDB();
        remapPosition(d, from, meta.pathLower);
        applyMoved(from, meta, act.view);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        showToast(act.done, async () => {
          try {
            const back = await moveToPath(meta.pathLower, from);
            const d2 = await loadDB();
            remapPosition(d2, meta.pathLower, back.pathLower);
            applyMoved(meta.pathLower, back, prevView);
            showToast('元に戻しました');
          } catch (e) {
            setErrModal({ title: '元に戻せませんでした', info: describeError(e) });
          }
        });
      } catch (e) {
        const info = describeError(e);
        setTracks((prev) => prev.map((x) => (x.pathLower === from ? { ...x, view: prevView } : x)));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        if (info.kind === 'keychain_locked' || info.kind === 'network') {
          const d = await loadDB();
          queueMove(d, { pathLower: from, name: t.name, dest: act.dest, lastError: info.code });
          setDb({ ...d });
          showToast(`移動を保留しました（${info.code}）`);
        } else {
          setErrModal({ title: '移動に失敗', info });
        }
      }
    },
    [applyMoved, showToast],
  );

  /* ---------- player ---------- */
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<Track | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null); // 読み込み中のパス
  const queueRef = useRef<Track[]>([]);
  const qIndexRef = useRef(-1);
  const currentRef = useRef<Track | null>(null);
  currentRef.current = current;
  /** step() から最新の設定を読むための参照（依存に db を入れると毎回作り直しになる） */
  const dbRef = useRef<DB | null>(null);
  dbRef.current = db;
  /** ランダム再生で「もう流した」ものを覚えておき、一巡するまで重複させない */
  const shufflePlayedRef = useRef<Set<string>>(new Set());
  const finishHandled = useRef(false);

  const playTrack = useCallback(
    async (track: Track, queue: Track[], index: number) => {
      // タップした瞬間に手応えを返す（リンク取得の待ち時間を沈黙させない）
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      setPreparing(track.pathLower);
      setCurrent(track);
      try {
        queueRef.current = queue;
        qIndexRef.current = index;
        finishHandled.current = false;
        shufflePlayedRef.current.add(track.pathLower);
        const url = await getTemporaryLink(track.pathLower);
        player.replace({ uri: url });
        const d = await loadDB();
        const rec = d.positions[track.pathLower];
        player.play();
        player.setPlaybackRate(d.settings.speed, 'high');
        if (rec && rec.dur > 0 && rec.pos > 3 && rec.pos < rec.dur * LISTENED_RATIO) {
          await player.seekTo(Math.max(0, rec.pos - 2));
        }
        player.setActiveForLockScreen(
          true,
          { title: track.name, artist: 'Akasha', albumTitle: track.folder },
          { showSeekForward: true, showSeekBackward: true },
        );
      } catch (e) {
        setErrModal({ title: '再生に失敗', info: describeError(e) });
      } finally {
        setPreparing(null);
      }
    },
    [player],
  );

  const step = useCallback(
    (delta: number) => {
      const q = queueRef.current;
      if (!q.length) return;

      // ランダム再生: まだ流していないものから無作為に選ぶ
      if (delta > 0 && dbRef.current?.settings.shuffle) {
        const cur = q[qIndexRef.current];
        let pool = q.filter((t) => !shufflePlayedRef.current.has(t.pathLower));
        if (!pool.length) {
          // 一巡したので履歴を畳む。直前の1曲だけは続けて流さない
          shufflePlayedRef.current = new Set(cur ? [cur.pathLower] : []);
          pool = q.filter((t) => t.pathLower !== cur?.pathLower);
        }
        if (!pool.length) { showToast('最後まで聴き終えました'); return; }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        playTrack(pick, q, q.indexOf(pick));
        return;
      }

      const next = qIndexRef.current + delta;
      if (next >= 0 && next < q.length) {
        playTrack(q[next], q, next);
      } else if (delta > 0) {
        // 終端で黙って止まらない（故障と区別がつくように）
        showToast('最後まで聴き終えました');
      }
    },
    [playTrack, showToast],
  );

  /* 再生位置の保存 + 95% 視聴済み */
  const lastSaved = useRef(0);
  useEffect(() => {
    const t = currentRef.current;
    if (!t || !db || !status.isLoaded || status.duration <= 0) return;
    const now = Date.now();
    if (now - lastSaved.current < 3000 && !status.didJustFinish) return;
    lastSaved.current = now;
    const rec = (db.positions[t.pathLower] = db.positions[t.pathLower] || { pos: 0, dur: 0 });
    rec.pos = status.currentTime;
    rec.dur = status.duration;
    rec.last = now;
    if (!rec.listened && status.currentTime / status.duration >= LISTENED_RATIO) {
      rec.listened = true;
    }
    persist();
  }, [status.currentTime, status.didJustFinish]);

  /* 再生完了 → 自動アーカイブ + 次へ */
  useEffect(() => {
    if (!status.didJustFinish || finishHandled.current) return;
    finishHandled.current = true;
    const t = currentRef.current;
    if (!t || !db) return;
    const rec = (db.positions[t.pathLower] = db.positions[t.pathLower] || { pos: 0, dur: 0 });
    rec.listened = true;
    rec.pos = 0;
    persist();
    if (db.settings.autoArchive && t.view === 'inbox') {
      const from = t.pathLower;
      moveToDir({ pathLower: from, name: t.name }, ARCHIVE_DIR)
        .then((meta) => {
          remapPosition(db, from, meta.pathLower);
          applyMoved(from, meta, 'archive');
        })
        .catch((e) => {
          const info = describeError(e);
          if (info.kind === 'gone') return; // すでに移動済み。次の再読み込みで整合する
          // ロック中のトークン読み出し失敗・一時的な通信断などは
          // 保留キューに積んで、アプリに戻ったときに自動で片付ける
          queueMove(db, { pathLower: from, name: t.name, dest: ARCHIVE_DIR, lastError: info.code });
          setDb({ ...db });
          showToast(`自動アーカイブを保留しました（${info.code}）`);
        });
    }
    if (db.settings.autoplayNext) step(1);
  }, [status.didJustFinish]);

  const cycleSpeed = useCallback(() => {
    if (!db) return;
    const i = SPEEDS.indexOf(db.settings.speed);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    db.settings.speed = next;
    player.setPlaybackRate(next, 'high');
    persist();
    setDb({ ...db });
    Haptics.selectionAsync().catch(() => {});
  }, [db, player]);

  /* ---------- アーカイブ一括削除 ----------
   * 実行するとモーダルはすぐ閉じ、あとはアプリ内のジョブとして裏で進む。
   * 削除中も再生・スワイプ・タブ切替は普通にできる（進捗は上部のバーに出る）。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDel, setBulkDel] = useState<Set<string>>(new Set()); // 選んだもの＝削除する
  const [bulkJob, setBulkJob] = useState<{ total: number; done: number; failed: number } | null>(null);
  const bulkCancelRef = useRef(false);
  const archiveTracks = useMemo(() => tracks.filter((t) => t.view === 'archive'), [tracks]);

  const runBulk = useCallback(async () => {
    const targets = archiveTracks.filter((t) => bulkDel.has(t.pathLower));
    if (!targets.length) return;

    // 先に閉じる。ここから先は裏で進む
    setBulkOpen(false);
    setBulkDel(new Set());
    bulkCancelRef.current = false;
    setBulkJob({ total: targets.length, done: 0, failed: 0 });

    let done = 0;
    let failed = 0;
    let lastInfo: ErrorInfo | null = null;

    for (const t of targets) {
      if (bulkCancelRef.current) break;
      try {
        const meta = await moveToTrash({ pathLower: t.pathLower, name: t.name });
        const d = await loadDB();
        remapPosition(d, t.pathLower, meta.pathLower);
        applyMoved(t.pathLower, meta, 'trash');   // 1件ずつ一覧から消える
        done++;
      } catch (e) {
        const info = describeError(e);
        if (info.kind === 'gone') {
          done++;   // すでに無い＝目的は達成されている
        } else {
          failed++;
          lastInfo = info;
          // 端末ロック・通信断は後で自動再試行できるよう積んでおく
          if (info.kind === 'keychain_locked' || info.kind === 'network') {
            const d = await loadDB();
            queueMove(d, { pathLower: t.pathLower, name: t.name, dest: TRASH_DIR, lastError: info.code });
            setDb({ ...d });
          }
        }
      }
      // 1件ごとに進捗を更新（途中で失敗しても止めない）
      setBulkJob((j) => (j ? { ...j, done, failed } : j));
    }

    const cancelled = bulkCancelRef.current;
    setBulkJob(null);
    Haptics.notificationAsync(
      failed > 0 ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});

    if (failed > 0 && lastInfo) {
      showToast(`${done}件を移動、${failed}件が失敗（${lastInfo.code}）`);
      setErrModal({ title: `一括削除で ${failed}件が失敗`, info: lastInfo });
    } else if (cancelled) {
      showToast(`中止しました（${done}/${targets.length}件は移動済み）`);
    } else {
      showToast(`${done}件を ${TRASH_DIR} へ移動しました`);
    }
  }, [archiveTracks, bulkDel, applyMoved, showToast]);

  const cancelBulk = useCallback(() => {
    Alert.alert('一括削除を中止しますか？', '途中まで移動したものは戻りません。', [
      { text: '続ける', style: 'cancel' },
      { text: '中止', style: 'destructive', onPress: () => { bulkCancelRef.current = true; } },
    ]);
  }, []);

  /* ---------- UI ---------- */
  if (authed === null || !db) {
    return (
      <SafeAreaView style={[s.root, s.center]}>
        <ActivityIndicator color={C.accent} />
      </SafeAreaView>
    );
  }

  if (!authed) {
    return (
      <SafeAreaView style={[s.root, s.center]}>
        <StatusBar barStyle="light-content" />
        <Text style={s.logo}>Akasha</Text>
        <Text style={s.connectDesc}>
          Dropbox の /podcast にある音声を{'\n'}ストリーミング再生します
        </Text>
        <Pressable style={press(s.btn)} disabled={!request} onPress={() => promptAsync()}>
          <Text style={s.btnText}>Dropbox に接続</Text>
        </Pressable>
        {DROPBOX_APP_KEY.startsWith('PASTE_') && (
          <Text style={s.warn}>⚠ src/config.ts に App key が未設定です</Text>
        )}
      </SafeAreaView>
    );
  }

  const signMsLeft = expiry ? expiry.getTime() - nowMs : null;
  const signUrgent = signMsLeft != null && signMsLeft < 86400000; // 残り1日を切ったら赤

  const pctOf = (t: Track) => {
    const r = db.positions[t.pathLower];
    return r && r.dur > 0 ? Math.min(1, r.pos / r.dur) : 0;
  };

  const pickSort = () => {
    const opts: SortKey[] = ['new', 'old', 'name'];
    Alert.alert(
      '並び順',
      `いまは「${SORT_LONG[sortKey]}」`,
      [
        ...opts.map((k) => ({
          text: k === sortKey ? `${SORT_LONG[k]}  ✓` : SORT_LONG[k],
          onPress: () => {
            if (!db) return;
            db.settings.sort = { ...db.settings.sort, [view]: k };
            persist();
            setDb({ ...db });
            Haptics.selectionAsync().catch(() => {});
          },
        })),
        { text: 'キャンセル', style: 'cancel' as const },
      ],
    );
  };

  const reconnect = () =>
    Alert.alert('Dropbox に接続し直しますか？', '再生位置・お気に入りの設定は消えません。', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '接続し直す',
        onPress: async () => { setSettingsOpen(false); await clearTokens(); setAuthed(false); },
      },
    ]);

  const disconnect = () =>
    Alert.alert('Dropbox 接続を解除しますか？', '', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '解除',
        style: 'destructive',
        onPress: async () => { setSettingsOpen(false); await clearTokens(); setAuthed(false); },
      },
    ]);

  // 空の画面は操作を教える場所にする
  const emptyText: Record<ViewName, string> = {
    inbox: '聴くものはありません。おつかれさま。',
    archive: 'アーカイブは空です。\n聴き終えたものがここに溜まります。',
    favorite: 'まだ何もありません。\nアーカイブで行を左にスワイプすると ★ に入ります。\n（★ から戻すときは左右どちらかにスワイプ）',
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />

      {/* view tabs
        * 件数が増えるとラベルが伸びて右端が切れていたので、タブだけ横スクロールにし、
        * 「設定」は縮まない枠に固定した（設定が押せなくなると詰むため）。 */}
      <View style={s.tabs}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.tabsScroll}
          contentContainerStyle={s.tabsScrollInner}
        >
          {(
            [
              ['inbox', 'Inbox', counts.inbox],
              ['archive', 'アーカイブ', counts.archive],
              ['favorite', 'お気に入り', counts.favorite],
            ] as Array<[ViewName, string, number]>
          ).map(([v, label, n]) => (
            <Pressable
              key={v}
              style={press([s.tab, view === v && s.tabActive] as ViewStyle[], { opacity: 0.6 })}
              onPress={() => { setView(v); Haptics.selectionAsync().catch(() => {}); }}
            >
              <Text style={[s.tabText, view === v && s.tabTextActive]} numberOfLines={1}>
                {label}{n > 0 ? ` ${n}` : ''}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable style={press(s.gearBtn, { opacity: 0.6 })} onPress={pickSort} hitSlop={8}>
          <Text style={s.sortBtn}>{SORT_SHORT[sortKey]} ▾</Text>
        </Pressable>
        <Pressable style={press(s.gearBtn, { opacity: 0.6 })} onPress={() => setSettingsOpen(true)} hitSlop={8}>
          <Text style={s.signout}>設定</Text>
        </Pressable>
      </View>

      {bulkJob && (
        <Pressable style={press(s.bulkProgress)} onPress={cancelBulk}>
          <View
            style={[
              s.bulkProgressFill,
              { width: `${((bulkJob.done + bulkJob.failed) / bulkJob.total) * 100}%` },
            ]}
          />
          <Text style={s.bulkProgressText}>
            {TRASH_DIR} へ移動中… {bulkJob.done + bulkJob.failed}/{bulkJob.total}
            {bulkJob.failed > 0 ? `（失敗 ${bulkJob.failed}）` : ''} — タップで中止
          </Text>
        </Pressable>
      )}

      {signMsLeft != null && signMsLeft < SIGN_WARN_DAYS * 86400000 && (
        <Pressable
          style={press(signUrgent ? s.signBarUrgent : s.signBar)}
          onPress={() =>
            Alert.alert(
              remainingLabel(signMsLeft),
              [
                `${expiry ? fmtExpiry(expiry) : ''} に署名が切れます。`,
                '',
                '無料Apple IDで署名したアプリは7日で開けなくなります。',
                '切れても再生位置・お気に入り・Dropbox接続は消えません。',
                '',
                '【いま出来ること】',
                '・iPhone をPCと同じ Wi-Fi に繋いでおく（Auto Refresh が再署名します）',
                '・急ぐなら USB 接続して Sideloadly で同じ IPA を入れ直す',
              ].join('\n'),
              [{ text: 'OK' }],
            )
          }
        >
          <Text style={signUrgent ? s.signTextUrgent : s.signText}>
            {remainingLabel(signMsLeft)}
            {expiry ? `（${fmtExpiry(expiry)}）` : ''} — タップで対処方法
          </Text>
        </Pressable>
      )}

      {db.pending.length > 0 && (
        <Pressable
          style={press(s.pendingBar)}
          onPress={() =>
            flushPending().then((n) => {
              showToast(n > 0 ? `${n}件を完了しました` : '再試行しましたが完了しませんでした');
              if (n > 0) reload();
            })
          }
        >
          <Text style={s.pendingText}>
            移動の保留 {db.pending.length}件（{db.pending[0].lastError}）— タップで再試行
          </Text>
        </Pressable>
      )}

      {/* 初回だけ出す操作ガイド。一度スワイプすれば以後この行は消える */}
      {visible.length > 0 && !db.settings.swipeHintDone[view] && (
        <Pressable style={press(s.hintBar)} onPress={() => markSwipeUsed(view)}>
          <Text style={s.hintText}>{SWIPE_HINT[view]}</Text>
        </Pressable>
      )}

      {view === 'archive' && archiveTracks.length > 0 && !bulkJob && (
        <Pressable
          style={press(s.bulkBtn)}
          onPress={() => { setBulkDel(new Set()); setBulkOpen(true); }}
        >
          <Text style={s.bulkBtnText}>アーカイブを一括削除…</Text>
        </Pressable>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      {/* list */}
      <FlatList
        data={visible}
        keyExtractor={(t) => t.pathLower}
        scrollEnabled={!swiping}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.accent} />
        }
        ListEmptyComponent={
          loading ? null : <Text style={s.empty}>{emptyText[view]}</Text>
        }
        contentContainerStyle={{ paddingBottom: 180 }}
        renderItem={({ item, index }) => {
          const rec = db.positions[item.pathLower];
          const isCur = current?.pathLower === item.pathLower;
          const isPreparing = preparing === item.pathLower;
          return (
            <SwipeableRow
              actions={SWIPE[view]}
              onSwipeActive={handleSwipeActive}
              onAction={(a) => { markSwipeUsed(view); runAction(item, a); }}
            >
              <Pressable
                style={press(
                  [s.row, isCur && s.rowCurrent] as ViewStyle[],
                  { backgroundColor: C.hover },
                )}
                onPress={() => playTrack(item, visible, index)}
              >
                <View style={[s.rowProgress, { width: `${pctOf(item) * 100}%` }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.rowTitle} numberOfLines={1}>{item.name}</Text>
                  <Text style={s.rowSub} numberOfLines={1}>
                    {item.folder}
                    {rec?.dur ? `  ${fmtTime(rec.dur)}` : ''}
                    {rec?.listened
                      ? '  ✓ 視聴済み'
                      : rec && rec.dur > 0 && rec.pos > 5
                        ? `  ${Math.floor((rec.pos / rec.dur) * 100)}%まで再生`
                        : ''}
                  </Text>
                </View>
                {isPreparing
                  ? <ActivityIndicator color={C.accent} style={{ marginLeft: 8 }} />
                  : isCur && <Text style={s.nowMark}>{status.playing ? '▶' : '⏸'}</Text>}
              </Pressable>
            </SwipeableRow>
          );
        }}
      />

      {toast && (
        <View style={s.toast}>
          <Text style={s.toastText} numberOfLines={2}>{toast.msg}</Text>
          {toast.undo && (
            <Pressable
              hitSlop={8}
              onPress={() => { const u = toast.undo!; setToast(null); u(); }}
            >
              <Text style={s.toastUndo}>元に戻す</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* player bar */}
      <View style={s.player}>
        <Text style={s.playerTitle} numberOfLines={1}>
          {preparing
            ? `読み込み中… ${current?.name ?? ''}`
            : current ? current.name : '未再生 — ファイルをタップ'}
        </Text>
        <View style={s.seekWrap}>
          <Text style={s.time}>{fmtTime(status.currentTime)}</Text>
          <Pressable
            style={s.seekBar}
            onPress={(e) => {
              if (status.duration > 0) {
                const x = e.nativeEvent.locationX;
                player.seekTo((x / seekWidth.current) * status.duration);
                Haptics.selectionAsync().catch(() => {});
              }
            }}
            onLayout={(e) => { seekWidth.current = e.nativeEvent.layout.width; }}
          >
            <View
              style={[
                s.seekFill,
                {
                  width: status.duration > 0
                    ? `${(status.currentTime / status.duration) * 100}%`
                    : '0%',
                },
              ]}
            />
          </Pressable>
          <Text style={s.time}>{fmtTime(status.duration)}</Text>
        </View>
        <View style={s.controls}>
          <Pressable style={press(s.cbtn)} onPress={cycleSpeed}>
            <Text style={s.cbtnText}>{db.settings.speed}x</Text>
          </Pressable>
          <Pressable style={press(s.cbtn)} onPress={() => player.seekTo(Math.max(0, status.currentTime - 15))}>
            <Text style={s.cbtnText}>-15s</Text>
          </Pressable>
          <Pressable
            style={press(s.playBtn)}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              if (!current) {
                if (visible.length) playTrack(visible[0], visible, 0);
                return;
              }
              if (status.playing) player.pause(); else player.play();
            }}
          >
            <Text style={s.playBtnText}>{status.playing ? '⏸' : '▶'}</Text>
          </Pressable>
          <Pressable style={press(s.cbtn)} onPress={() => player.seekTo(status.currentTime + 30)}>
            <Text style={s.cbtnText}>+30s</Text>
          </Pressable>
          <Pressable style={press(s.cbtn)} onPress={() => step(1)}>
            <Text style={s.cbtnText}>次へ</Text>
          </Pressable>
        </View>
        <View style={s.togglesRow}>
          <Pressable
            onPress={() => {
              db.settings.autoplayNext = !db.settings.autoplayNext;
              persist(); setDb({ ...db });
              Haptics.selectionAsync().catch(() => {});
            }}
          >
            <Text style={[s.toggle, db.settings.autoplayNext && s.toggleOn]}>連続再生</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              db.settings.shuffle = !db.settings.shuffle;
              shufflePlayedRef.current = new Set(current ? [current.pathLower] : []);
              persist(); setDb({ ...db });
              Haptics.selectionAsync().catch(() => {});
            }}
          >
            <Text style={[s.toggle, db.settings.shuffle && s.toggleOn]}>ランダム再生</Text>
          </Pressable>
        </View>
      </View>

      {/* 設定（普段は触らないものをここに集約） */}
      <Modal visible={settingsOpen} animationType="slide" transparent onRequestClose={() => setSettingsOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>設定</Text>

            <Pressable
              style={press(s.setRow, { backgroundColor: C.hover })}
              onPress={() => {
                db.settings.autoArchive = !db.settings.autoArchive;
                persist(); setDb({ ...db });
                Haptics.selectionAsync().catch(() => {});
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.setLabel}>聴き終えたら自動アーカイブ</Text>
                <Text style={s.setSub}>95%まで聴いたら Inbox から {ARCHIVE_DIR} へ移す</Text>
              </View>
              <Text style={[s.setState, db.settings.autoArchive && s.setStateOn]}>
                {db.settings.autoArchive ? 'ON' : 'OFF'}
              </Text>
            </Pressable>

            <Text style={s.setSection}>Dropbox</Text>
            <Pressable style={press(s.setRow, { backgroundColor: C.hover })} onPress={reconnect}>
              <Text style={[s.setLabel, { flex: 1 }]}>接続し直す</Text>
              <Text style={s.setSub}>認証が切れたときに</Text>
            </Pressable>
            <Pressable style={press(s.setRow, { backgroundColor: C.hover })} onPress={disconnect}>
              <Text style={[s.setLabel, { flex: 1, color: C.danger }]}>接続を解除</Text>
            </Pressable>

            <Text style={s.setSection}>情報</Text>
            <Text style={s.setInfo}>バージョン {APP_VERSION}</Text>
            <Text style={s.setInfo}>
              署名の期限 {expiry ? fmtExpiry(expiry) : '—'}
              {signMsLeft != null ? `（${remainingLabel(signMsLeft)}）` : ''}
            </Text>

            <View style={s.modalBtns}>
              <Pressable style={press(s.btn)} onPress={() => setSettingsOpen(false)}>
                <Text style={s.btnText}>閉じる</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* エラー詳細（コード + 原因 + 対処） */}
      <Modal visible={!!errModal} animationType="fade" transparent onRequestClose={() => setErrModal(null)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>{errModal?.title}</Text>

            <Text style={s.errLabel}>原因</Text>
            <Text style={s.errBody} selectable>{errModal?.info.cause}</Text>

            <Text style={s.errLabel}>対処</Text>
            <Text style={s.errBody} selectable>{errModal?.info.hint}</Text>

            <Text style={s.errLabel}>エラーコード</Text>
            <Text style={s.errCode} selectable>{errModal?.info.code}</Text>

            <Text style={s.errLabel}>詳細（改修用・長押しでコピー）</Text>
            <ScrollView style={s.errRawBox}>
              <Text style={s.errRaw} selectable>{errModal?.info.raw}</Text>
            </ScrollView>

            <View style={s.modalBtns}>
              {(errModal?.info.kind === 'not_authenticated' ||
                errModal?.info.kind === 'token_refresh_failed') && (
                <Pressable
                  style={press([s.btn, s.btnGhost] as ViewStyle[])}
                  onPress={async () => { setErrModal(null); await clearTokens(); setAuthed(false); }}
                >
                  <Text style={[s.btnText, { color: C.text }]}>接続を解除</Text>
                </Pressable>
              )}
              <Pressable
                style={press([s.btn, s.btnGhost] as ViewStyle[])}
                onPress={() => { setErrModal(null); reload(); }}
              >
                <Text style={[s.btnText, { color: C.text }]}>再読み込み</Text>
              </Pressable>
              <Pressable style={press(s.btn)} onPress={() => setErrModal(null)}>
                <Text style={s.btnText}>閉じる</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 一括削除モーダル: 既定は「全部残す」。消したいものだけ選ぶ */}
      <Modal visible={bulkOpen} animationType="slide" transparent>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>アーカイブを一括削除</Text>
            <Text style={s.modalDesc}>
              消したいものをタップして選んでください。{'\n'}
              選ばなかったものはアーカイブに残ります。
            </Text>
            <Pressable
              style={press(s.selectAll)}
              onPress={() =>
                setBulkDel(
                  bulkDel.size === archiveTracks.length
                    ? new Set()
                    : new Set(archiveTracks.map((t) => t.pathLower)),
                )
              }
            >
              <Text style={s.selectAllText}>
                {bulkDel.size === archiveTracks.length ? '選択をすべて解除' : 'すべて選択'}
              </Text>
            </Pressable>
            <FlatList
              data={archiveTracks}
              keyExtractor={(t) => t.pathLower}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => {
                const del = bulkDel.has(item.pathLower);
                return (
                  <Pressable
                    style={press(s.bulkRow, { opacity: 0.6 })}
                    onPress={() => {
                      const next = new Set(bulkDel);
                      if (del) next.delete(item.pathLower); else next.add(item.pathLower);
                      setBulkDel(next);
                      Haptics.selectionAsync().catch(() => {});
                    }}
                  >
                    <Text style={[s.bulkName, del && { color: C.faint, textDecorationLine: 'line-through' }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={[s.bulkTag, del && s.bulkTagDel]}>
                      {del ? `${TRASH_DIR} へ削除` : '残す'}
                    </Text>
                  </Pressable>
                );
              }}
            />
            <Text style={s.bulkNote}>
              実行するとこの画面は閉じ、あとは裏で進みます。
            </Text>
            <Text style={s.bulkNote}>
              削除中も再生・スワイプ・タブ切替は普通に使えます（進捗は画面上部に出ます）。
            </Text>
            <View style={s.modalBtns}>
              <Pressable style={press([s.btn, s.btnGhost] as ViewStyle[])} onPress={() => setBulkOpen(false)}>
                <Text style={[s.btnText, { color: C.text }]}>キャンセル</Text>
              </Pressable>
              <Pressable
                style={press([s.btn, bulkDel.size === 0 && s.btnDisabled] as ViewStyle[])}
                disabled={bulkDel.size === 0}
                onPress={runBulk}
              >
                <Text style={s.btnText}>削除 {bulkDel.size}件を実行</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const toneBox: Record<Tone, ViewStyle> = {
  normal: { backgroundColor: C.hover, borderWidth: 1, borderColor: C.border },
  fav: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent },
  danger: { backgroundColor: 'rgba(224,108,108,0.16)', borderWidth: 1, borderColor: C.danger },
};
const toneText: Record<Tone, { color: string }> = {
  normal: { color: C.text },
  fav: { color: C.accentStrong },
  danger: { color: C.danger },
};

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  logo: { color: C.accent, fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  connectDesc: { color: C.dim, textAlign: 'center', lineHeight: 22 },
  warn: { color: C.danger, fontSize: 12, marginTop: 8 },
  signout: { color: C.faint, fontSize: 12 },
  tabs: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 14, paddingRight: 6, paddingTop: 6, paddingBottom: 8,
  },
  tabsScroll: { flexGrow: 1, flexShrink: 1 },
  tabsScrollInner: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 6 },
  gearBtn: { flexGrow: 0, flexShrink: 0, paddingHorizontal: 8, paddingVertical: 7 },
  sortBtn: { color: C.dim, fontSize: 12 },
  tab: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 18, backgroundColor: C.elev1 },
  tabActive: { backgroundColor: C.accentSoft },
  tabText: { color: C.dim, fontSize: 13 },
  tabTextActive: { color: C.accentStrong, fontWeight: '600' },
  pendingBar: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 7, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent,
  },
  pendingText: { color: C.accentStrong, fontSize: 12 },
  signBar: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 7, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent,
  },
  signText: { color: C.accentStrong, fontSize: 12, fontWeight: '600' },
  signBarUrgent: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 7, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: 'rgba(224,108,108,0.16)', borderWidth: 1, borderColor: C.danger,
  },
  signTextUrgent: { color: C.danger, fontSize: 12, fontWeight: '700' },
  hintBar: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 6, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: C.elev1,
  },
  hintText: { color: C.faint, fontSize: 11 },
  bulkBtn: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 8, borderRadius: 9,
    borderWidth: 1, borderColor: C.danger, alignItems: 'center',
  },
  bulkBtnText: { color: C.danger, fontSize: 13, fontWeight: '600' },
  error: { color: C.danger, paddingHorizontal: 18, paddingBottom: 8, fontSize: 12 },
  empty: { color: C.faint, textAlign: 'center', marginTop: 60, lineHeight: 22 },
  row: {
    marginHorizontal: 12, marginVertical: 3, padding: 13, borderRadius: 12,
    backgroundColor: C.elev1, flexDirection: 'row', alignItems: 'center',
    overflow: 'hidden',
  },
  rowCurrent: { borderWidth: 1, borderColor: C.accent, backgroundColor: C.accentSoft },
  rowProgress: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(232,136,77,0.08)',
  },
  rowTitle: { color: C.text, fontSize: 14, fontWeight: '500' },
  rowSub: { color: C.faint, fontSize: 11.5, marginTop: 2 },
  nowMark: { color: C.accentStrong, fontSize: 16, marginLeft: 8 },
  swipeBg: {
    position: 'absolute', left: 12, right: 12, top: 3, bottom: 3,
    borderRadius: 12, backgroundColor: C.elev2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  swipeBgText: { color: C.dim, fontSize: 12.5, fontWeight: '700' },
  swipeSub: { color: C.faint, fontSize: 10.5, marginTop: 2 },
  toast: {
    position: 'absolute', left: 20, right: 20, bottom: 200,
    backgroundColor: C.elev2, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingVertical: 10, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  toastText: { color: C.text, fontSize: 12.5, flex: 1 },
  toastUndo: { color: C.accentStrong, fontSize: 12.5, fontWeight: '700' },
  player: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#1D1F25', borderTopWidth: 1, borderTopColor: C.border,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 26, gap: 8,
  },
  playerTitle: { color: C.text, fontSize: 13, fontWeight: '600' },
  seekWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  time: { color: C.dim, fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 42 },
  seekBar: { flex: 1, height: 22, justifyContent: 'center' },
  seekFill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  cbtn: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9, backgroundColor: C.elev2,
    minWidth: 52, alignItems: 'center',
  },
  cbtnText: { color: C.text, fontSize: 13, fontWeight: '600' },
  playBtn: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  playBtnText: { color: '#1A1208', fontSize: 20, fontWeight: '700' },
  togglesRow: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  toggle: {
    color: C.faint, fontSize: 11.5, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, overflow: 'hidden',
  },
  toggleOn: { color: C.accentStrong, borderColor: C.accent, backgroundColor: C.accentSoft },
  btn: {
    backgroundColor: C.accent, paddingHorizontal: 20, paddingVertical: 11,
    borderRadius: 10, alignItems: 'center',
  },
  btnGhost: { backgroundColor: C.elev2 },
  btnDisabled: { backgroundColor: C.elev2, opacity: 0.5 },
  btnText: { color: '#1A1208', fontWeight: '700', fontSize: 14 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modal: {
    backgroundColor: C.elev1, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 20, gap: 8, paddingBottom: 34,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  modalDesc: { color: C.dim, fontSize: 12, lineHeight: 18 },
  selectAll: {
    alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14, backgroundColor: C.elev2,
  },
  selectAllText: { color: C.dim, fontSize: 12 },
  setRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: C.elev2, marginTop: 6,
  },
  setLabel: { color: C.text, fontSize: 14 },
  setSub: { color: C.faint, fontSize: 11, marginTop: 2 },
  setState: { color: C.faint, fontSize: 13, fontWeight: '700', minWidth: 34, textAlign: 'right' },
  setStateOn: { color: C.accentStrong },
  setSection: { color: C.faint, fontSize: 11, marginTop: 14, letterSpacing: 0.5 },
  setInfo: { color: C.dim, fontSize: 12, marginTop: 4 },
  errLabel: { color: C.faint, fontSize: 11, marginTop: 6, letterSpacing: 0.5 },
  errBody: { color: C.text, fontSize: 13, lineHeight: 19 },
  errCode: {
    color: C.accentStrong, fontSize: 12.5, fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  errRawBox: {
    maxHeight: 130, backgroundColor: C.bg, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, padding: 8,
  },
  errRaw: { color: C.dim, fontSize: 11, lineHeight: 16 },
  bulkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  bulkName: { flex: 1, color: C.text, fontSize: 13 },
  bulkTag: { color: C.faint, fontSize: 11 },
  bulkTagDel: { color: C.danger, fontWeight: '700' },
  bulkNote: { color: C.faint, fontSize: 11, lineHeight: 17, marginTop: 4 },
  bulkProgress: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 7, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: C.elev2, borderWidth: 1, borderColor: C.danger,
    overflow: 'hidden', justifyContent: 'center',
  },
  bulkProgressFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(224,108,108,0.22)',
  },
  bulkProgressText: { color: C.danger, fontSize: 12, fontWeight: '600' },
  modalBtns: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 10 },
});
