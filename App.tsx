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
import { DB, loadDB, persist, queueMove, remapPosition } from './src/store';
import { ErrorInfo, describeError } from './src/errors';

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_URI = makeRedirectUri({ scheme: 'akasha', path: 'oauth' });
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];
type ViewName = 'inbox' | 'archive' | 'favorite';

/* ---------- スワイプの割り当て ----------
 * 左（右→左）＝送り出す。浅い＝そのビューで一番よく使う行き先、深い＝もう一段強い操作。
 * 右（左→右）＝ひとつ戻す。
 */
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

const SWIPE: Record<ViewName, SwipeSet> = {
  inbox:    { shallow: A_ARCHIVE,  deep: A_FAVORITE },
  archive:  { shallow: A_FAVORITE, deep: A_TRASH, right: A_INBOX },
  favorite: { right: A_ARCHIVE },
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
  children,
}: {
  actions: SwipeSet;
  onAction: (a: SwipeAction) => void;
  children: React.ReactNode;
}) {
  const tx = useRef(new Animated.Value(0)).current;
  const [dragging, setDragging] = useState(false);
  const [dir, setDir] = useState(0);                       // -1: 左, 1: 右
  const [armed, setArmed] = useState<SwipeAction | null>(null);

  // PanResponder は作り直さない。最新の値は ref 経由で読む
  const actRef = useRef(actions);
  const onActionRef = useRef(onAction);
  const armedRef = useRef<SwipeAction | null>(null);
  actRef.current = actions;
  onActionRef.current = onAction;

  const enabled = !!(actions.shallow || actions.deep || actions.right);

  const pan = useRef(
    PanResponder.create({
      // 横方向にはっきり動いたときだけ引き取る（縦スクロールを邪魔しない）
      onMoveShouldSetPanResponder: (_e, g) => {
        const a = actRef.current;
        if (!a.shallow && !a.deep && !a.right) return false;
        return Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6;
      },
      onPanResponderGrant: () => setDragging(true),
      onPanResponderMove: (_e, g) => {
        const a = actRef.current;
        const hasLeft = !!(a.shallow || a.deep);
        const hasRight = !!a.right;
        // 行き先が無い方向は抵抗をかけて「ここには何も無い」と伝える
        const resist = (g.dx < 0 && !hasLeft) || (g.dx > 0 && !hasRight);
        tx.setValue(resist ? g.dx / 4 : g.dx);
        setDir(g.dx === 0 ? 0 : g.dx < 0 ? -1 : 1);

        let next: SwipeAction | null = null;
        if (g.dx < 0 && hasLeft) {
          if (-g.dx >= DEEP && a.deep) next = a.deep;
          else if (-g.dx >= SHALLOW) next = a.shallow ?? a.deep ?? null;
        } else if (g.dx > 0 && hasRight && g.dx >= SHALLOW) {
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
      onPanResponderRelease: (_e, g) => {
        setDragging(false);
        const fire = armedRef.current;
        armedRef.current = null;
        setArmed(null);
        setDir(0);
        if (fire) {
          Animated.timing(tx, {
            toValue: g.dx < 0 ? -480 : 480,
            duration: 150,
            useNativeDriver: true,
          }).start(() => {
            onActionRef.current(fire);
            tx.setValue(0);
          });
        } else {
          Animated.spring(tx, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => {
        setDragging(false);
        armedRef.current = null;
        setArmed(null);
        setDir(0);
        Animated.spring(tx, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
    }),
  ).current;

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDB().then(setDb);
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
      flushPending()
        .then((n) => { if (n > 0) { showToast(`保留していた移動 ${n}件を完了しました`); reload(); } })
        .catch(() => {});
    });
    return () => sub.remove();
  }, [flushPending, reload, showToast]);

  const visible = useMemo(
    () =>
      tracks
        .filter((t) => t.view === view)
        .sort((a, b) => (b.serverModified || '').localeCompare(a.serverModified || '')),
    [tracks, view],
  );
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

  /* ---------- アーカイブ一括削除（「削除の道具」に戻した） ---------- */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDel, setBulkDel] = useState<Set<string>>(new Set()); // 選んだもの＝削除する
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const archiveTracks = useMemo(() => tracks.filter((t) => t.view === 'archive'), [tracks]);

  const runBulk = useCallback(async () => {
    const toTrash = archiveTracks.filter((t) => bulkDel.has(t.pathLower));
    let done = 0;
    try {
      for (const t of toTrash) {
        setBulkBusy(`${TRASH_DIR} へ移動中… ${++done}/${toTrash.length}`);
        await moveToTrash(t);
      }
      setBulkOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      showToast(`${done}件を ${TRASH_DIR} へ移動しました`);
      await reload();
    } catch (e) {
      setBulkOpen(false);
      setErrModal({ title: '一括削除に失敗', info: describeError(e) });
    } finally {
      setBulkBusy(null);
    }
  }, [archiveTracks, bulkDel, reload, showToast]);

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

  const pctOf = (t: Track) => {
    const r = db.positions[t.pathLower];
    return r && r.dur > 0 ? Math.min(1, r.pos / r.dur) : 0;
  };

  const disconnect = () =>
    Alert.alert('Dropbox 接続を解除しますか？', '', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '解除',
        style: 'destructive',
        onPress: async () => { await clearTokens(); setAuthed(false); },
      },
    ]);

  // 空の画面は操作を教える場所にする
  const emptyText: Record<ViewName, string> = {
    inbox: '聴くものはありません。おつかれさま。',
    archive: 'アーカイブは空です。\n聴き終えたものがここに溜まります。',
    favorite: 'まだ何もありません。\nアーカイブで行を左にスワイプすると ★ に入ります。',
  };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />

      {/* view tabs（ロゴ行は廃止。接続解除はここに畳んだ） */}
      <View style={s.tabs}>
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
            <Text style={[s.tabText, view === v && s.tabTextActive]}>
              {label}{n > 0 ? ` ${n}` : ''}
            </Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable onPress={disconnect} hitSlop={10}>
          <Text style={s.signout}>接続解除</Text>
        </Pressable>
      </View>

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

      {view === 'archive' && archiveTracks.length > 0 && (
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
            <SwipeableRow actions={SWIPE[view]} onAction={(a) => runAction(item, a)}>
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
            onPress={() => { db.settings.autoplayNext = !db.settings.autoplayNext; persist(); setDb({ ...db }); }}
          >
            <Text style={[s.toggle, db.settings.autoplayNext && s.toggleOn]}>連続再生</Text>
          </Pressable>
          <Pressable
            onPress={() => { db.settings.autoArchive = !db.settings.autoArchive; persist(); setDb({ ...db }); }}
          >
            <Text style={[s.toggle, db.settings.autoArchive && s.toggleOn]}>
              聴き終えたら自動アーカイブ
            </Text>
          </Pressable>
        </View>
      </View>

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
            {bulkBusy ? (
              <Text style={s.bulkBusy}>{bulkBusy}</Text>
            ) : (
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
            )}
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
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8,
  },
  tab: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 18, backgroundColor: C.elev1 },
  tabActive: { backgroundColor: C.accentSoft },
  tabText: { color: C.dim, fontSize: 13 },
  tabTextActive: { color: C.accentStrong, fontWeight: '600' },
  pendingBar: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 7, paddingHorizontal: 10,
    borderRadius: 9, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent,
  },
  pendingText: { color: C.accentStrong, fontSize: 12 },
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
  bulkBusy: { color: C.accentStrong, textAlign: 'center', paddingVertical: 10 },
  modalBtns: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 10 },
});
