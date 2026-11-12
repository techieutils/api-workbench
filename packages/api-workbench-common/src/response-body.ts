/**
 * What a response body is, from its Content-Type and, when that is missing or generic, its first
 * bytes. The main process uses it to decide whether to keep the original bytes (anything that is
 * not text); the response viewer uses it to choose a preview.
 */

export type BodyKind =
  'text' | 'html' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video' | 'font' | 'stream' | 'binary';

/** The largest body whose original bytes are kept for previews and downloads (25 MiB). */
export const PREVIEW_BYTE_LIMIT = 25 * 1024 * 1024;

const TEXT_TYPES =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-yaml|toml|csv|x-ndjson|ndjson|jsonl|x-sh|sql|problem\+json|problem\+xml|ld\+json|manifest\+json|xhtml\+xml)\b)|[+/](json|xml|yaml|ndjson)\b/i;
const IMAGE_TYPES =
  /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon|apng)\b/i;

/** The media type without parameters, in lower case: `Image/PNG; q=1` gives `image/png`. */
export const mediaType = (contentType: string | undefined): string =>
  (contentType || '').split(';')[0].trim().toLowerCase();

/** Whether bytes of this type read as text, so decoding them as UTF-8 loses nothing. */
export const isTextType = (contentType: string | undefined): boolean =>
  TEXT_TYPES.test(mediaType(contentType));

/** Recognises common formats by their first bytes, for responses without a useful Content-Type. */
export function sniff(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftypavif')) return 'image/avif';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (ascii(0, 'ID3') || starts(0xff, 0xfb)) return 'audio/mpeg';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(4, 'ftyp')) return 'video/mp4';
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(0, 'wOF2')) return 'font/woff2';
  if (ascii(0, 'wOFF')) return 'font/woff';
  return undefined;
}

/**
 * The kind of body to show. `application/octet-stream` stays a stream (shown as it is, not
 * previewed); its bytes are only sniffed when no Content-Type was sent at all.
 */
export function bodyKind(contentType: string | undefined, head?: Uint8Array): BodyKind {
  let type = mediaType(contentType);
  if (!type && head) type = sniff(head) || '';
  if (!type) return 'text';
  if (type === 'application/octet-stream') return 'stream';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (IMAGE_TYPES.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('font/') || /^application\/(font-woff2?|x-font-(ttf|otf|woff))$/.test(type))
    return 'font';
  return isTextType(type) ? 'text' : 'binary';
}

/** The type to label a preview with, and to give its blob: the header's, or the sniffed one. */
export function effectiveType(contentType: string | undefined, head?: Uint8Array): string {
  return mediaType(contentType) || (head && sniff(head)) || 'text/plain';
}

/** A file extension for downloading a body of this type. */
export function extensionFor(contentType: string): string {
  const type = mediaType(contentType);
  const known: Record<string, string> = {
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'text/html': 'html',
    'text/css': 'css',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/javascript': 'js',
    'text/javascript': 'js',
    'application/yaml': 'yaml',
    'application/x-yaml': 'yaml',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'application/octet-stream': 'bin',
  };
  if (known[type]) return known[type];
  if (/[+/]json$/.test(type)) return 'json';
  if (/[+/]xml$/.test(type)) return 'xml';
  return 'bin';
}
