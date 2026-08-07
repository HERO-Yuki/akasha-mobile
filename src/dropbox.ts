/**
 * Dropbox API クライアント（PKCE OAuth + files API）
 */
import * as SecureStore from 'expo-secure-store';
import {
  DROPBOX_APP_KEY, PODCAST_ROOT, ARCHIVE_DIR, TRASH_DIR, FAVORITES_DIR, AUDIO_EXTS,
} from './config';
import { AkashaError } from './errors';

export const DISCOVERY = {
  authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
};

const KEY_REFRESH = 'akasha.dbx.refresh_token';
const KEY_ACCESS = 'akasha.dbx.access_token';
const KEY_EXPIRES = 'akasha.dbx.expires_at';

/**
 * expo-secure-store の既定は WHEN_UNLOCKED（＝端末ロック中は読めない）。
 * ロック画面で聴き終えた瞬間の自動アーカイブは Dropbox API を呼ぶため、
 * 既定のままだとトークンを読めずに必ず失敗する。初回ロック解除以降なら
 * 読める AFTER_FIRST_UNLOCK に変更する。
 */
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export type View = 'inbox' | 'archive' | 'favorite';

export interface Track {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
  folder: string;
  view: View | 'trash';
  size: number;
  serverModified: string;
}

/* ---------------- token 管理 ---------------- */

/** 直近のアクセストークンをメモリに持ち、SecureStore への読み出し回数を減らす */
let memAccess: { token: string; expiresAt: number } | null = null;

async function readSecure(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e) {
    // 端末ロック中・キーチェーン保護レベル不一致などで読めない
    throw new AkashaError({ kind: 'keychain_locked', raw: `${key}: ${String(e)}` });
  }
}

export async function saveTokens(t: {
  access_token: string; refresh_token?: string; expires_in?: number;
}): Promise<void> {
  const expiresAt = Date.now() + ((t.expires_in ?? 14400) - 300) * 1000;
  await SecureStore.setItemAsync(KEY_ACCESS, t.access_token, SECURE_OPTS);
  if (t.refresh_token) await SecureStore.setItemAsync(KEY_REFRESH, t.refresh_token, SECURE_OPTS);
  await SecureStore.setItemAsync(KEY_EXPIRES, String(expiresAt), SECURE_OPTS);
  memAccess = { token: t.access_token, expiresAt };
}

export async function hasRefreshToken(): Promise<boolean> {
  try {
    return !!(await SecureStore.getItemAsync(KEY_REFRESH));
  } catch {
    return false;
  }
}

export async function clearTokens(): Promise<void> {
  memAccess = null;
  await SecureStore.deleteItemAsync(KEY_ACCESS);
  await SecureStore.deleteItemAsync(KEY_REFRESH);
  await SecureStore.deleteItemAsync(KEY_EXPIRES);
}

/**
 * 旧ビルドで WHEN_UNLOCKED として保存されたトークンを AFTER_FIRST_UNLOCK で保存し直す。
 * アプリ起動時（＝ロック解除済み）に一度だけ呼ぶ。失敗しても無視してよい。
 */
export async function migrateKeychainAccessibility(): Promise<void> {
  try {
    const [access, refresh, expires] = await Promise.all([
      SecureStore.getItemAsync(KEY_ACCESS),
      SecureStore.getItemAsync(KEY_REFRESH),
      SecureStore.getItemAsync(KEY_EXPIRES),
    ]);
    if (access) await SecureStore.setItemAsync(KEY_ACCESS, access, SECURE_OPTS);
    if (refresh) await SecureStore.setItemAsync(KEY_REFRESH, refresh, SECURE_OPTS);
    if (expires) await SecureStore.setItemAsync(KEY_EXPIRES, expires, SECURE_OPTS);
  } catch {
    /* 端末ロック中などで読めなければ次回起動で再試行される */
  }
}

export async function getAccessToken(): Promise<string> {
  if (memAccess && Date.now() < memAccess.expiresAt) return memAccess.token;

  const access = await readSecure(KEY_ACCESS);
  const expiresAt = Number((await readSecure(KEY_EXPIRES)) || 0);
  if (access && Date.now() < expiresAt) {
    memAccess = { token: access, expiresAt };
    return access;
  }

  const refresh = await readSecure(KEY_REFRESH);
  if (!refresh) throw new AkashaError({ kind: 'not_authenticated', raw: 'refresh token not stored' });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: DROPBOX_APP_KEY,
  }).toString();

  let res: Response;
  try {
    res = await fetch(DISCOVERY.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    throw new AkashaError({ kind: 'network', raw: `token refresh: ${String(e)}` });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AkashaError({
      kind: 'token_refresh_failed',
      status: res.status,
      raw: `token refresh (${res.status}): ${text.slice(0, 400)}`,
    });
  }
  const json = await res.json();
  await saveTokens(json);
  return json.access_token as string;
}

/* ---------------- RPC helper ---------------- */

/** Dropbox のエラー本文から error_summary を取り出す */
function parseSummary(text: string): string {
  try {
    const j = JSON.parse(text);
    if (typeof j.error_summary === 'string') return j.error_summary;
  } catch {
    /* JSON でないこともある */
  }
  return '';
}

const RETRYABLE = /too_many_write_operations|too_many_requests/;

async function rpc<T>(endpoint: string, arg: unknown, attempt = 0): Promise<T> {
  const token = await getAccessToken();

  let res: Response;
  try {
    res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(arg),
    });
  } catch (e) {
    throw new AkashaError({ kind: 'network', endpoint, raw: `${endpoint}: ${String(e)}` });
  }

  if (res.ok) return res.json() as Promise<T>;

  const text = await res.text().catch(() => '');
  const summary = parseSummary(text);

  // 書き込み競合・レート制限は少し待って自動で再試行（最大3回）
  if ((res.status === 429 || RETRYABLE.test(summary)) && attempt < 2) {
    const waitMs = 800 * (attempt + 1);
    await new Promise((r) => setTimeout(r, waitMs));
    return rpc<T>(endpoint, arg, attempt + 1);
  }

  // 401 は保存済みトークンを捨てて次回リフレッシュさせる
  if (res.status === 401) memAccess = null;

  throw new AkashaError({
    kind: 'dropbox',
    endpoint,
    status: res.status,
    summary,
    raw: `${endpoint} (${res.status}): ${text.slice(0, 600)}`,
  });
}

/* ---------------- files API ---------------- */

function classify(pathLower: string): Track['view'] {
  const rel = pathLower.slice(PODCAST_ROOT.length + 1); // "archives/foo.mp3" 等
  const first = rel.split('/')[0];
  if (first === ARCHIVE_DIR.toLowerCase()) return 'archive';
  if (first === TRASH_DIR.toLowerCase()) return 'trash';
  if (first === FAVORITES_DIR.toLowerCase()) return 'favorite';
  return 'inbox';
}

interface ListFolderResult {
  entries: Array<{
    '.tag': string; id: string; name: string;
    path_lower: string; path_display: string;
    size?: number; server_modified?: string;
  }>;
  cursor: string;
  has_more: boolean;
}

/** /podcast 以下を再帰的に列挙して Track に変換（trash は呼び出し側で非表示） */
export async function listPodcast(): Promise<Track[]> {
  const tracks: Track[] = [];
  let result = await rpc<ListFolderResult>('files/list_folder', {
    path: PODCAST_ROOT,
    recursive: true,
    limit: 2000,
    include_non_downloadable_files: false,
  });
  for (;;) {
    for (const e of result.entries) {
      if (e['.tag'] !== 'file') continue;
      const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
      if (!AUDIO_EXTS.has(ext)) continue;
      const parts = e.path_display.split('/');
      tracks.push({
        id: e.id,
        name: e.name,
        pathLower: e.path_lower,
        pathDisplay: e.path_display,
        folder: parts.slice(2, -1).join('/') || '(直下)',
        view: classify(e.path_lower),
        size: e.size ?? 0,
        serverModified: e.server_modified ?? '',
      });
    }
    if (!result.has_more) break;
    result = await rpc<ListFolderResult>('files/list_folder/continue', { cursor: result.cursor });
  }
  return tracks;
}

/** ストリーミング再生用の一時リンク（約4時間有効） */
export async function getTemporaryLink(pathLower: string): Promise<string> {
  const r = await rpc<{ link: string }>('files/get_temporary_link', { path: pathLower });
  return r.link;
}

const knownFolders = new Set<string>();

async function ensureFolder(path: string): Promise<void> {
  if (knownFolders.has(path)) return;
  try {
    await rpc('files/create_folder_v2', { path, autorename: false });
  } catch (e) {
    // 既に存在する場合（path/conflict/folder）だけ無視。認証・通信エラーは通す
    const conflict = e instanceof AkashaError && (e.summary ?? '').startsWith('path/conflict');
    if (!conflict) throw e;
  }
  knownFolders.add(path);
}

export interface MovedMeta {
  name: string;
  pathLower: string;
  pathDisplay: string;
}

/** 移動対象。Track でも、保留キューの最小情報でも渡せる */
export interface Movable {
  pathLower: string;
  name: string;
}

/** 任意のパスへ移動する。「元に戻す」は移動前のフルパスをそのまま渡す */
export async function moveToPath(fromPathLower: string, toPath: string): Promise<MovedMeta> {
  const r = await rpc<{
    metadata: { name: string; path_lower: string; path_display: string };
  }>('files/move_v2', {
    from_path: fromPathLower,
    to_path: toPath,
    autorename: true,
  });
  return {
    name: r.metadata.name,
    pathLower: r.metadata.path_lower,
    pathDisplay: r.metadata.path_display,
  };
}

/**
 * ファイルを PODCAST_ROOT/<destDir>/ へ移動し、移動後のメタデータを返す。
 * destDir が空文字なら PODCAST_ROOT 直下（＝Inbox）へ戻す。
 */
export async function moveToDir(track: Movable, destDir: string): Promise<MovedMeta> {
  const destFolder = destDir ? `${PODCAST_ROOT}/${destDir}` : PODCAST_ROOT;
  if (destDir) await ensureFolder(destFolder);
  return moveToPath(track.pathLower, `${destFolder}/${track.name}`);
}

export const moveToArchive = (t: Movable) => moveToDir(t, ARCHIVE_DIR);
export const moveToTrash = (t: Movable) => moveToDir(t, TRASH_DIR);
export const moveToFavorites = (t: Movable) => moveToDir(t, FAVORITES_DIR);
