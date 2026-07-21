/**
 * Dropbox API クライアント（PKCE OAuth + files API）
 */
import * as SecureStore from 'expo-secure-store';
import {
  DROPBOX_APP_KEY, PODCAST_ROOT, ARCHIVE_DIR, TRASH_DIR, FAVORITES_DIR, AUDIO_EXTS,
} from './config';

export const DISCOVERY = {
  authorizationEndpoint: 'https://www.dropbox.com/oauth2/authorize',
  tokenEndpoint: 'https://api.dropboxapi.com/oauth2/token',
};

const KEY_REFRESH = 'akasha.dbx.refresh_token';
const KEY_ACCESS = 'akasha.dbx.access_token';
const KEY_EXPIRES = 'akasha.dbx.expires_at';

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

export async function saveTokens(t: {
  access_token: string; refresh_token?: string; expires_in?: number;
}): Promise<void> {
  await SecureStore.setItemAsync(KEY_ACCESS, t.access_token);
  if (t.refresh_token) await SecureStore.setItemAsync(KEY_REFRESH, t.refresh_token);
  const expiresAt = Date.now() + ((t.expires_in ?? 14400) - 300) * 1000;
  await SecureStore.setItemAsync(KEY_EXPIRES, String(expiresAt));
}

export async function hasRefreshToken(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(KEY_REFRESH));
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_ACCESS);
  await SecureStore.deleteItemAsync(KEY_REFRESH);
  await SecureStore.deleteItemAsync(KEY_EXPIRES);
}

export async function getAccessToken(): Promise<string> {
  const access = await SecureStore.getItemAsync(KEY_ACCESS);
  const expiresAt = Number(await SecureStore.getItemAsync(KEY_EXPIRES) || 0);
  if (access && Date.now() < expiresAt) return access;

  const refresh = await SecureStore.getItemAsync(KEY_REFRESH);
  if (!refresh) throw new Error('not_authenticated');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: DROPBOX_APP_KEY,
  }).toString();
  const res = await fetch(DISCOVERY.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token_refresh_failed: ${res.status}`);
  const json = await res.json();
  await saveTokens(json);
  return json.access_token as string;
}

/* ---------------- RPC helper ---------------- */

async function rpc<T>(endpoint: string, arg: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(arg),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
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

async function ensureFolder(path: string): Promise<void> {
  try {
    await rpc('files/create_folder_v2', { path, autorename: false });
  } catch (e) {
    // 既に存在する場合(409)は無視
  }
}

/** ファイルを PODCAST_ROOT/<destDir>/ へ移動 */
export async function moveToDir(track: Track, destDir: string): Promise<void> {
  const destFolder = `${PODCAST_ROOT}/${destDir}`;
  await ensureFolder(destFolder);
  await rpc('files/move_v2', {
    from_path: track.pathLower,
    to_path: `${destFolder}/${track.name}`,
    autorename: true,
  });
}

export const moveToArchive = (t: Track) => moveToDir(t, ARCHIVE_DIR);
export const moveToTrash = (t: Track) => moveToDir(t, TRASH_DIR);
export const moveToFavorites = (t: Track) => moveToDir(t, FAVORITES_DIR);
