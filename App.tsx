/**
 * Akasha — クラウド参照 音声プレイヤー（iOS / Expo）
 *
 * - Dropbox /podcast を参照（App_036 AudioInbox 運用準拠）
 * - Inbox / アーカイブ / お気に入り ビュー（trash は非表示）
 * - 聴き終えたら自動でアーカイブへ移動
 * - アーカイブ一括削除: 除外→favorites / それ以外→trash
 * - バックグラウンド再生・ロック画面コントロール（expo-audio）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl,
  SafeAreaView, StatusBar, StyleSheet, Text, View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri, useAuthRequest, exchangeCodeAsync } from 'expo-auth-session';
import { DROPBOX_APP_KEY, LISTENED_RATIO, FAVORITES_DIR, TRASH_DIR } from './src/config';
import { C } from './src/theme';
import {
  DISCOVERY, Track, listPodcast, getTemporaryLink,
  moveToArchive, moveToTrash, moveToFavorites,
  saveTokens, hasRefreshToken, clearTokens,
} from './src/dropbox';
import { DB, loadDB, persist } from './src/store';

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_URI = makeRedirectUri({ scheme: 'akasha', path: 'oauth' });
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];
type ViewName = 'inbox' | 'archive' | 'favorite';

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '–:––';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

const seekWidth = { current: 1 };

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
    hasRefreshToken().then(setAuthed);
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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTracks(await listPodcast());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed) reload();
  }, [authed, reload]);

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

  /* ---------- player ---------- */
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<Track | null>(null);
  const queueRef = useRef<Track[]>([]);
  const qIndexRef = useRef(-1);
  const currentRef = useRef<Track | null>(null);
  currentRef.current = current;
  const finishHandled = useRef(false);

  const playTrack = useCallback(
    async (track: Track, queue: Track[], index: number) => {
      try {
        queueRef.current = queue;
        qIndexRef.current = index;
        finishHandled.current = false;
        setCurrent(track);
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
        Alert.alert('再生エラー', String(e));
      }
    },
    [player],
  );

  const step = useCallback(
    (delta: number) => {
      const q = queueRef.current;
      const next = qIndexRef.current + delta;
      if (next >= 0 && next < q.length) playTrack(q[next], q, next);
    },
    [playTrack],
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
      moveToArchive(t)
        .then(() => {
          setTracks((prev) =>
            prev.map((x) => (x.pathLower === t.pathLower ? { ...x, view: 'archive' as const } : x)),
          );
        })
        .catch((e) => Alert.alert('アーカイブ移動に失敗', String(e)));
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
  }, [db, player]);

  /* ---------- アーカイブ一括削除 ---------- */
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkKeep, setBulkKeep] = useState<Set<string>>(new Set()); // 除外(=お気に入り行き)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const archiveTracks = useMemo(() => tracks.filter((t) => t.view === 'archive'), [tracks]);

  const runBulk = useCallback(async () => {
    const toFav = archiveTracks.filter((t) => bulkKeep.has(t.pathLower));
    const toTrash = archiveTracks.filter((t) => !bulkKeep.has(t.pathLower));
    let done = 0;
    const total = toFav.length + toTrash.length;
    try {
      for (const t of toFav) {
        setBulkBusy(`お気に入りへ移動中… ${++done}/${total}`);
        await moveToFavorites(t);
      }
      for (const t of toTrash) {
        setBulkBusy(`${TRASH_DIR} へ移動中… ${++done}/${total}`);
        await moveToTrash(t);
      }
      setBulkOpen(false);
      await reload();
    } catch (e) {
      Alert.alert('移動に失敗', String(e));
    } finally {
      setBulkBusy(null);
    }
  }, [archiveTracks, bulkKeep, reload]);

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
        <Pressable style={s.btn} disabled={!request} onPress={() => promptAsync()}>
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

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />

      {/* header */}
      <View style={s.header}>
        <Text style={s.logo}>Akasha</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() =>
            Alert.alert('Dropbox 接続を解除しますか？', '', [
              { text: 'キャンセル', style: 'cancel' },
              {
                text: '解除',
                style: 'destructive',
                onPress: async () => { await clearTokens(); setAuthed(false); },
              },
            ])
          }
        >
          <Text style={s.signout}>接続解除</Text>
        </Pressable>
      </View>

      {/* view tabs */}
      <View style={s.tabs}>
        {(
          [
            ['inbox', 'Inbox', counts.inbox],
            ['archive', 'アーカイブ', counts.archive],
            ['favorite', 'お気に入り', counts.favorite],
          ] as Array<[ViewName, string, number]>
        ).map(([v, label, n]) => (
          <Pressable key={v} style={[s.tab, view === v && s.tabActive]} onPress={() => setView(v)}>
            <Text style={[s.tabText, view === v && s.tabTextActive]}>
              {label}{n > 0 ? ` ${n}` : ''}
            </Text>
          </Pressable>
        ))}
      </View>

      {view === 'archive' && archiveTracks.length > 0 && (
        <Pressable
          style={s.bulkBtn}
          onPress={() => { setBulkKeep(new Set()); setBulkOpen(true); }}
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
          loading ? null : <Text style={s.empty}>このビューにはファイルがありません</Text>
        }
        contentContainerStyle={{ paddingBottom: 180 }}
        renderItem={({ item, index }) => {
          const rec = db.positions[item.pathLower];
          const isCur = current?.pathLower === item.pathLower;
          return (
            <Pressable
              style={[s.row, isCur && s.rowCurrent]}
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
              {isCur && <Text style={s.nowMark}>{status.playing ? '▶' : '⏸'}</Text>}
            </Pressable>
          );
        }}
      />

      {/* player bar */}
      <View style={s.player}>
        <Text style={s.playerTitle} numberOfLines={1}>
          {current ? current.name : '未再生 — ファイルをタップ'}
        </Text>
        <View style={s.seekWrap}>
          <Text style={s.time}>{fmtTime(status.currentTime)}</Text>
          <Pressable
            style={s.seekBar}
            onPress={(e) => {
              if (status.duration > 0) {
                const x = e.nativeEvent.locationX;
                player.seekTo((x / seekWidth.current) * status.duration);
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
          <Pressable style={s.cbtn} onPress={cycleSpeed}>
            <Text style={s.cbtnText}>{db.settings.speed}x</Text>
          </Pressable>
          <Pressable style={s.cbtn} onPress={() => player.seekTo(Math.max(0, status.currentTime - 15))}>
            <Text style={s.cbtnText}>-15s</Text>
          </Pressable>
          <Pressable
            style={s.playBtn}
            onPress={() => {
              if (!current) {
                if (visible.length) playTrack(visible[0], visible, 0);
                return;
              }
              if (status.playing) player.pause(); else player.play();
            }}
          >
            <Text style={s.playBtnText}>{status.playing ? '⏸' : '▶'}</Text>
          </Pressable>
          <Pressable style={s.cbtn} onPress={() => player.seekTo(status.currentTime + 30)}>
            <Text style={s.cbtnText}>+30s</Text>
          </Pressable>
          <Pressable style={s.cbtn} onPress={() => step(1)}>
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

      {/* 一括削除モーダル */}
      <Modal visible={bulkOpen} animationType="slide" transparent>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>アーカイブを一括削除</Text>
            <Text style={s.modalDesc}>
              チェック（☑）のものは {TRASH_DIR}/ へ移動し、一覧に表示されなくなります。{'\n'}
              タップして除外（★）したものは {FAVORITES_DIR}/（お気に入り）へ移動します。
            </Text>
            <FlatList
              data={archiveTracks}
              keyExtractor={(t) => t.pathLower}
              style={{ maxHeight: 360 }}
              renderItem={({ item }) => {
                const kept = bulkKeep.has(item.pathLower);
                return (
                  <Pressable
                    style={s.bulkRow}
                    onPress={() => {
                      const next = new Set(bulkKeep);
                      if (kept) next.delete(item.pathLower); else next.add(item.pathLower);
                      setBulkKeep(next);
                    }}
                  >
                    <Text style={[s.bulkCheck, kept && s.bulkCheckKeep]}>
                      {kept ? '★' : '☑'}
                    </Text>
                    <Text style={[s.bulkName, kept && { color: C.accentStrong }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={s.bulkTag}>{kept ? 'お気に入りへ' : '削除'}</Text>
                  </Pressable>
                );
              }}
            />
            {bulkBusy ? (
              <Text style={s.bulkBusy}>{bulkBusy}</Text>
            ) : (
              <View style={s.modalBtns}>
                <Pressable style={[s.btn, s.btnGhost]} onPress={() => setBulkOpen(false)}>
                  <Text style={[s.btnText, { color: C.text }]}>キャンセル</Text>
                </Pressable>
                <Pressable style={s.btn} onPress={runBulk}>
                  <Text style={s.btnText}>
                    実行（削除 {archiveTracks.length - bulkKeep.size} / ★ {bulkKeep.size}）
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  logo: { color: C.accent, fontSize: 22, fontWeight: '700', letterSpacing: 1 },
  connectDesc: { color: C.dim, textAlign: 'center', lineHeight: 22 },
  warn: { color: C.danger, fontSize: 12, marginTop: 8 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingVertical: 10,
  },
  signout: { color: C.faint, fontSize: 12 },
  tabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  tab: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18, backgroundColor: C.elev1 },
  tabActive: { backgroundColor: C.accentSoft },
  tabText: { color: C.dim, fontSize: 13 },
  tabTextActive: { color: C.accentStrong, fontWeight: '600' },
  bulkBtn: {
    marginHorizontal: 14, marginBottom: 8, paddingVertical: 8, borderRadius: 9,
    borderWidth: 1, borderColor: C.danger, alignItems: 'center',
  },
  bulkBtnText: { color: C.danger, fontSize: 13, fontWeight: '600' },
  error: { color: C.danger, paddingHorizontal: 18, paddingBottom: 8, fontSize: 12 },
  empty: { color: C.faint, textAlign: 'center', marginTop: 60 },
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
  btnText: { color: '#1A1208', fontWeight: '700', fontSize: 14 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modal: {
    backgroundColor: C.elev1, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 20, gap: 12, paddingBottom: 34,
  },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: '700' },
  modalDesc: { color: C.dim, fontSize: 12, lineHeight: 18 },
  bulkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  bulkCheck: { fontSize: 16, color: C.danger },
  bulkCheckKeep: { color: C.accentStrong },
  bulkName: { flex: 1, color: C.text, fontSize: 13 },
  bulkTag: { color: C.faint, fontSize: 11 },
  bulkBusy: { color: C.accentStrong, textAlign: 'center', paddingVertical: 10 },
  modalBtns: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
});
