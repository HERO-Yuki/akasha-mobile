/**
 * 再生位置・視聴済み・設定の永続化（AsyncStorage）
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

export interface DB {
  positions: Record<string, PositionRecord>;
  settings: Settings;
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
    };
  } catch {
    cache = { positions: {}, settings: { ...DEFAULTS } };
  }
  return cache;
}

export function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (cache) AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {});
  }, 400);
}
