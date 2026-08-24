/**
 * サイドロード署名の期限
 *
 * 無料Apple IDで署名したアプリは7日で開けなくなる（データは消えない）。
 * 期限は日数を推測するのではなく、**Sideloadly が署名時に埋め込む
 * `embedded.mobileprovision` の ExpirationDate** から読む。これが唯一の正確な出所。
 *
 * - 未署名ビルド／シミュレータ／Expo Go では読めない → その場合は何も出さない
 * - 一度読めた値は AsyncStorage に控え、読めなかった回のフォールバックにする
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';

const CACHE_KEY = 'akasha.signing.expiresAt';

/** .mobileprovision は CMS 署名の中に平文の XML plist が挟まっている。そこだけ取り出す */
function extractPlist(bytes: Uint8Array): string | null {
  let s = '';
  const CHUNK = 0x8000; // 一度に渡しすぎると引数上限に当たる
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const start = s.indexOf('<?xml');
  const end = s.indexOf('</plist>');
  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + '</plist>'.length);
}

async function readFromProfile(): Promise<number | null> {
  const f = new File(Paths.bundle, 'embedded.mobileprovision');
  if (!f.exists) return null;
  const plist = extractPlist(await f.bytes());
  if (!plist) return null;
  const m = plist.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

/**
 * 署名の期限を返す。読めなければ最後に読めた値、それも無ければ null。
 * 再署名すると値が変わるので、毎回まず実物を読みに行く。
 */
export async function loadSigningExpiry(): Promise<Date | null> {
  try {
    const t = await readFromProfile();
    if (t != null) {
      AsyncStorage.setItem(CACHE_KEY, String(t)).catch(() => {});
      return new Date(t);
    }
  } catch {
    // 読めないビルド形態もある。キャッシュに落とす
  }
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const t = raw ? Number(raw) : NaN;
    if (!Number.isNaN(t)) return new Date(t);
  } catch {
    /* ignore */
  }
  return null;
}

/** 「8/31 11:16」のような短い表記 */
export function fmtExpiry(d: Date): string {
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

/** 残りの表示文言。日をまたぐ前は時間で出す */
export function remainingLabel(msLeft: number): string {
  if (msLeft <= 0) return '署名が切れています';
  const hours = Math.floor(msLeft / 3600000);
  if (hours < 24) return `署名まであと ${hours} 時間`;
  return `署名まであと ${Math.floor(hours / 24)} 日`;
}
