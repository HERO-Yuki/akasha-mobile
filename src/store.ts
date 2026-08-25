/**
 * 再生位置・視聴済み・設定・保留中の移動の永続化（AsyncStorage）
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'akasha.v1';

export interface PositionRecord {
  pos: number;
  dur: number;
  listened?: boolean;
  last?: number;
}

/** 名前順は「かな始まり」だけ期待通りに並ぶ。漢字は読みが分からないので文字コード順になる */
export type SortKey = 'new' | 'old' | 'name';

export interface Settings {
  speed: number;
  autoplayNext: boolean;
  autoArchive: boolean;
  /** 連続再生のときに順番でなく無作為に選ぶ。既定はOFF */
  shuffle: boolean;
  /** 一覧の並び順。ビューごとに覚える（用途が違うので） */
  sort: Record<string, SortKey>;
  /** ビューごとに一度スワイプしたか。操作ガイドを出すか判断するのに使う */
  swipeHintDone: Record<string, boolean>;
}

/** 失敗した移動。アプリを開き直したとき／再読み込み時に自動で再試行する */
export interface PendingMove {
  pathLower: string;
  name: string;
  dest: string;      // ARCHIVE_DIR / FAVORITES_DIR / TRASH_DIR
  at: number;
  tries: number;
  lastError?: string; // 直近のエラーコード（画面表示用）
}

export interface DB {
  positions: Record<string, PositionRecord>;
  settings: Settings;
  pending: PendingMove[];
  /** 一度きりの移行処理を二度走らせないための記録 */
  migrations: Record<string, boolean>;
}

const DEFAULT_SORT: Record<string, SortKey> = { inbox: 'new', archive: 'new', favorite: 'new' };
const DEFAULTS: Settings = {
  speed: 1, autoplayNext: true, autoArchive: true, shuffle: false,
  sort: DEFAULT_SORT, swipeHintDone: {},
};

let cache: DB | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadDB(): Promise<DB> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    cache = {
      positions: parsed.positions ?? {},
      settings: { ...DEFAULTS, ...(parsed.settings ?? {}) },
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      migrations: parsed.migrations ?? {},
    };
    // 旧バージョンの保存データにはキーが無いので補う。
    // DEFAULTS の中のオブジェクトをそのまま使うと、書き換えたときに
    // DEFAULTS 自体を汚してしまうので必ず複製する。
    const ps = parsed.settings ?? {};
    cache.settings.swipeHintDone = { ...(ps.swipeHintDone ?? {}) };
    cache.settings.sort = { ...DEFAULT_SORT, ...(ps.sort ?? {}) };
    if (typeof cache.settings.shuffle !== 'boolean') cache.settings.shuffle = false;

    // 自動アーカイブが失敗し続けていた頃（v0.2未満）に手で切ったまま、という状態が
    // 実際にあった。原因は解消済みなので **一度だけ** 既定のONへ戻す。
    // 以後にユーザーが切った場合はそのまま尊重する（このフラグで二度目は走らない）。
    if (!cache.migrations.autoArchiveResetV032) {
      cache.settings.autoArchive = true;
      cache.migrations.autoArchiveResetV032 = true;
      persist();
    }
  } catch {
    cache = {
      positions: {},
      settings: { ...DEFAULTS, sort: { ...DEFAULT_SORT }, swipeHintDone: {} },
      pending: [], migrations: {},
    };
  }
  return cache;
}

export function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (cache) AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {});
  }, 400);
}

/** 同じファイルを二重に積まない */
export function queueMove(db: DB, m: Omit<PendingMove, 'at' | 'tries'>): void {
  const i = db.pending.findIndex((p) => p.pathLower === m.pathLower);
  if (i >= 0) {
    db.pending[i] = { ...db.pending[i], ...m, tries: db.pending[i].tries + 1 };
  } else {
    db.pending.push({ ...m, at: Date.now(), tries: 1 });
  }
  persist();
}

export function dequeueMove(db: DB, pathLower: string): void {
  db.pending = db.pending.filter((p) => p.pathLower !== pathLower);
  persist();
}

/** ファイル移動でパスが変わったとき、再生位置の記録も新しいパスへ引き継ぐ */
export function remapPosition(db: DB, from: string, to: string): void {
  if (from === to) return;
  const rec = db.positions[from];
  if (!rec) return;
  db.positions[to] = rec;
  delete db.positions[from];
  persist();
}
