/**
 * エラーの構造化と「原因・対処」への翻訳
 *
 * 画面には必ず 3点セットで出す:
 *   - コード  … 問い合わせ／改修時に使う機械的な識別子（例: `409 from_lookup/not_found`）
 *   - 原因    … なぜ失敗したのか（日本語）
 *   - 対処    … いま何をすればいいか
 */

export type ErrorKind =
  | 'keychain_locked'      // 端末ロック中でトークンを読めない
  | 'not_authenticated'    // 未接続 / トークン消失
  | 'token_refresh_failed' // refresh token が失効
  | 'network'              // 通信できない
  | 'gone'                 // 移動元がもう無い（＝すでに移動済みとみなせる）
  | 'dropbox'              // Dropbox API のその他エラー
  | 'unknown';

export class AkashaError extends Error {
  kind: ErrorKind;
  status?: number;
  summary?: string;   // Dropbox の error_summary（例: "from_lookup/not_found/..."）
  endpoint?: string;
  raw: string;

  constructor(init: {
    kind: ErrorKind;
    raw: string;
    status?: number;
    summary?: string;
    endpoint?: string;
  }) {
    super(`${init.kind}${init.status ? ` (${init.status})` : ''}: ${init.summary ?? init.raw}`);
    this.name = 'AkashaError';
    this.kind = init.kind;
    this.raw = init.raw;
    this.status = init.status;
    this.summary = init.summary;
    this.endpoint = init.endpoint;
    Object.setPrototypeOf(this, AkashaError.prototype);
  }
}

export interface ErrorInfo {
  kind: ErrorKind;
  code: string;   // 短い識別子
  cause: string;  // 原因
  hint: string;   // 対処
  raw: string;    // 生のレスポンス（詳細欄用）
}

/** Dropbox の error_summary → 原因・対処。前方一致で引く（順序が優先度） */
const DBX_TABLE: Array<[string, ErrorKind, string, string]> = [
  [
    'from_lookup/not_found',
    'gone',
    '移動元のファイルが Dropbox 上に見つかりません。別の端末（PCの App_036 や Dropbox アプリ）ですでに移動・削除されたか、アプリ内の一覧が古くなっています。',
    '一覧を下に引いて再読み込みしてください。すでに目的の場所にあるなら対応は不要です。',
  ],
  [
    'from_lookup/not_folder',
    'dropbox',
    '移動元のパスがファイルとして解決できません。',
    '一覧を再読み込みしてください。',
  ],
  [
    'from_lookup/restricted_content',
    'dropbox',
    'Dropbox 側でこのファイルの操作が制限されています（著作権ブロックなど）。',
    'Dropbox の Web 画面で該当ファイルの状態を確認してください。',
  ],
  [
    'from_write/no_write_permission',
    'dropbox',
    '移動元フォルダへの書き込み権限がありません。共有フォルダの閲覧のみ権限などが原因です。',
    'Dropbox 側でフォルダの権限を確認してください。',
  ],
  [
    'to/conflict',
    'dropbox',
    '移動先に同じ名前のファイルがあり、名前の自動変更でも解決できませんでした。',
    'Dropbox 上で移動先フォルダの重複ファイルを整理してください。',
  ],
  [
    'to/insufficient_space',
    'dropbox',
    'Dropbox の空き容量が足りません。',
    '不要なファイルを削除して容量を空けてください。',
  ],
  [
    'to/no_write_permission',
    'dropbox',
    '移動先フォルダへの書き込み権限がありません。',
    'Dropbox 側でフォルダの権限を確認してください。',
  ],
  [
    'too_many_write_operations',
    'dropbox',
    '同じアカウントへの書き込みが同時に集中しています（PC の Dropbox 同期と競合しているときに起きます）。',
    '数秒おいて再試行してください。アプリ側でも自動で3回まで再試行します。',
  ],
  [
    'too_many_requests',
    'dropbox',
    'Dropbox API のレート制限に達しました。',
    '少し時間をおいて再試行してください。',
  ],
  [
    'invalid_access_token',
    'not_authenticated',
    'アクセストークンが無効です。Dropbox 側で連携が解除された可能性があります。',
    '「接続解除」してから、もう一度 Dropbox に接続し直してください。',
  ],
  [
    'expired_access_token',
    'not_authenticated',
    'アクセストークンの期限が切れ、自動更新にも失敗しました。',
    '「接続解除」してから、もう一度 Dropbox に接続し直してください。',
  ],
  [
    'missing_scope',
    'dropbox',
    'Dropbox アプリに必要な権限が付いていません（ファイル移動には files.content.write が必要）。',
    'Dropbox App Console の Permissions で account_info.read / files.metadata.read / files.content.read / files.content.write を有効にし、Submit してから接続し直してください。',
  ],
  [
    'path/not_found',
    'gone',
    '対象のパスが存在しません。',
    '一覧を下に引いて再読み込みしてください。',
  ],
];

function fromStatus(status: number): { kind: ErrorKind; cause: string; hint: string } {
  if (status === 401)
    return {
      kind: 'not_authenticated',
      cause: 'Dropbox の認証が通りませんでした（401）。',
      hint: '「接続解除」してから接続し直してください。',
    };
  if (status === 403)
    return {
      kind: 'dropbox',
      cause: 'この操作がアカウントに許可されていません（403）。',
      hint: 'Dropbox アプリの権限設定（Permissions）を確認してください。',
    };
  if (status === 429)
    return {
      kind: 'dropbox',
      cause: 'Dropbox API のレート制限に達しました（429）。',
      hint: '少し時間をおいて再試行してください。',
    };
  if (status >= 500)
    return {
      kind: 'dropbox',
      cause: `Dropbox 側でエラーが発生しています（${status}）。アプリの不具合ではありません。`,
      hint: 'しばらく待ってから再試行してください。',
    };
  return {
    kind: 'dropbox',
    cause: `Dropbox API がエラーを返しました（${status}）。`,
    hint: '下の「詳細」を控えて改修の材料にしてください。',
  };
}

export function describeError(e: unknown): ErrorInfo {
  if (e instanceof AkashaError) {
    const ep = e.endpoint ? `${e.endpoint} ` : '';

    if (e.kind === 'keychain_locked')
      return {
        kind: e.kind,
        code: 'keychain_locked',
        cause:
          '端末がロックされている間は、保存された Dropbox のトークンを読み出せませんでした。ロック画面で聴き終えたときの自動アーカイブが失敗する典型的な原因です。',
        hint:
          'アプリを一度開き直すと自動で再試行します（画面上部の「自動アーカイブ待ち」をタップしても実行できます）。このビルドではキーチェーンの保護レベルを AFTER_FIRST_UNLOCK に変更済みなので、再インストール後は起きなくなります。',
        raw: e.raw,
      };

    if (e.kind === 'not_authenticated')
      return {
        kind: e.kind,
        code: 'not_authenticated',
        cause: 'Dropbox のトークンが端末に保存されていません（未接続、または接続が解除されています）。',
        hint: '「Dropbox に接続」からもう一度接続してください。',
        raw: e.raw,
      };

    if (e.kind === 'token_refresh_failed')
      return {
        kind: e.kind,
        code: `token_refresh_failed${e.status ? ` ${e.status}` : ''}`,
        cause:
          'アクセストークンの自動更新に失敗しました。リフレッシュトークンが失効している（Dropbox 側で連携解除された／App key が変わった）可能性があります。',
        hint: '「接続解除」してから、もう一度 Dropbox に接続し直してください。',
        raw: e.raw,
      };

    if (e.kind === 'network')
      return {
        kind: e.kind,
        code: 'network',
        cause:
          '通信できませんでした。圏外・機内モード・Wi-Fi 切り替えの瞬間、またはバックグラウンドで通信が止められた可能性があります。',
        hint: '電波の良い場所でアプリを開き直すと自動で再試行します。',
        raw: e.raw,
      };

    if (e.kind === 'dropbox' || e.kind === 'gone') {
      const sum = e.summary ?? '';
      for (const [prefix, kind, cause, hint] of DBX_TABLE) {
        if (sum.startsWith(prefix)) {
          return {
            kind,
            code: `${ep}${e.status ?? ''} ${prefix}`.trim(),
            cause,
            hint,
            raw: e.raw,
          };
        }
      }
      const byStatus = fromStatus(e.status ?? 0);
      return {
        kind: byStatus.kind,
        code: `${ep}${e.status ?? ''} ${sum.split('/')[0] || 'unknown'}`.trim(),
        cause: byStatus.cause + (sum ? `\nDropbox の応答: ${sum}` : ''),
        hint: byStatus.hint,
        raw: e.raw,
      };
    }
  }

  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/Network request failed|Failed to fetch|timeout/i.test(raw))
    return {
      kind: 'network',
      code: 'network',
      cause: '通信できませんでした（圏外・機内モード・回線切り替えなど）。',
      hint: '電波の良い場所で再試行してください。',
      raw,
    };

  return {
    kind: 'unknown',
    code: 'unknown',
    cause: '想定していないエラーです。',
    hint: '下の「詳細」をそのまま控えて、改修の材料にしてください。',
    raw,
  };
}
