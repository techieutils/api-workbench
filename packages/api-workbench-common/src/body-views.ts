/** Byte views of a response body for the response editor: a hex dump and Base64. */

/** The most bytes the hex view shows; a hex dump is about four times the size of its input. */
export const HEX_VIEW_BYTE_LIMIT = 1024 * 1024;

/**
 * The body's bytes: the original bytes when the main process kept them (binary bodies), otherwise
 * the UTF-8 encoding of the text it decoded.
 */
export function bodyBytes(body: string, bodyBase64?: string): Uint8Array {
  if (!bodyBase64) return new TextEncoder().encode(body);
  const text = atob(bodyBase64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** Bytes as Base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  // String.fromCharCode takes its bytes as arguments, so convert in chunks under the call limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

/**
 * A hex dump: an offset, sixteen bytes in hex, and their printable ASCII, per line. Bytes past
 * `limit` are left out, with a closing line that says how many.
 */
export function hexDump(bytes: Uint8Array, limit = Infinity): string {
  const shown = bytes.subarray(0, limit);
  const lines: string[] = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const row = [...shown.subarray(offset, offset + 16)];
    const hex = row.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = row
      .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  const hidden = bytes.length - shown.length;
  if (hidden > 0) lines.push(`… ${hidden.toLocaleString('en-US')} more bytes not shown`);
  return lines.join('\n');
}
