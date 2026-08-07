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

export interface Settings {
  speed: number;
  autoplayNext: boolean;
  autoArchive: boolean;
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
}

const DEFAULTS: Settings = { speed: 1, autoplayNext: true, autoArchive: true };

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
    };
  } catch {
    cache = { positions: {}, settings: { ...DEFAULTS }, pending: [] };
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
