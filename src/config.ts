/**
 * Akasha モバイル設定
 *
 * DROPBOX_APP_KEY:
 *   https://www.dropbox.com/developers/apps で作成したアプリの App key を貼る。
 *   - Choose an API: Scoped access
 *   - Type of access: Full Dropbox（/podcast を参照するため）
 *   - Permissions タブで以下を有効化して Submit:
 *       account_info.read / files.metadata.read / files.content.read / files.content.write
 *   - Settings タブ > OAuth 2 > Redirect URIs に `akasha://oauth` を追加
 */
export const DROPBOX_APP_KEY = 'dheoqv7fl2o2tt8';

/** Dropbox 上の音声ルート（App_036 AudioInbox と同じ運用） */
export const PODCAST_ROOT = '/podcast';

/** 仕分けフォルダ名（PODCAST_ROOT 直下）。App_036 互換のため既定は archives / trash */
export const ARCHIVE_DIR = 'archives';
export const TRASH_DIR = 'trash';      // 「_trash」等にしたい場合はここを変更
export const FAVORITES_DIR = 'favorites';

/** この割合まで再生したら「視聴済み」扱い（App_036 準拠） */
export const LISTENED_RATIO = 0.95;

export const AUDIO_EXTS = new Set([
  'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'webm', 'wma',
]);
