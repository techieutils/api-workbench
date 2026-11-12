import { createHmac, randomBytes } from 'node:crypto';

// NTLM over HTTP (MS-NLMP), NTLMv2 only: a negotiate message, the server's challenge, and the
// authenticate message that answers it. LM and NTLMv1 responses are never sent.

/** MD4 (RFC 1320). Node's OpenSSL build often leaves it out, and NTLM needs it for the password hash. */
export function md4(input: Uint8Array): Buffer {
  const length = input.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const x = new Array<number>(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getUint32(block + i * 4, true);
    const [aa, bb, cc, dd] = [a, b, c, d];
    const f = (p: number, q: number, r: number) => (p & q) | (~p & r);
    const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
    const h = (p: number, q: number, r: number) => p ^ q ^ r;
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + f(b, c, d) + x[i]) | 0, 3);
      d = rotl((d + f(a, b, c) + x[i + 1]) | 0, 7);
      c = rotl((c + f(d, a, b) + x[i + 2]) | 0, 11);
      b = rotl((b + f(c, d, a) + x[i + 3]) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + g(b, c, d) + x[i] + 0x5a827999) | 0, 3);
      d = rotl((d + g(a, b, c) + x[i + 4] + 0x5a827999) | 0, 5);
      c = rotl((c + g(d, a, b) + x[i + 8] + 0x5a827999) | 0, 9);
      b = rotl((b + g(c, d, a) + x[i + 12] + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + h(b, c, d) + x[i] + 0x6ed9eba1) | 0, 3);
      d = rotl((d + h(a, b, c) + x[i + 8] + 0x6ed9eba1) | 0, 9);
      c = rotl((c + h(d, a, b) + x[i + 4] + 0x6ed9eba1) | 0, 11);
      b = rotl((b + h(c, d, a) + x[i + 12] + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((word, i) => out.writeInt32LE(word, i * 4));
  return out;
}

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1');
const NEGOTIATE_UNICODE = 0x00000001;
const NEGOTIATE_OEM = 0x00000002;
const REQUEST_TARGET = 0x00000004;
const NEGOTIATE_NTLM = 0x00000200;
const ALWAYS_SIGN = 0x00008000;
const EXTENDED_SESSION_SECURITY = 0x00080000;
const NEGOTIATE_TARGET_INFO = 0x00800000;
const NEGOTIATE_128 = 0x20000000;
const NEGOTIATE_56 = 0x80000000;
const NEGOTIATE_FLAGS =
  (NEGOTIATE_UNICODE |
    NEGOTIATE_OEM |
    REQUEST_TARGET |
    NEGOTIATE_NTLM |
    ALWAYS_SIGN |
    EXTENDED_SESSION_SECURITY |
    NEGOTIATE_128 |
    NEGOTIATE_56) >>>
  0;
const utf16 = (value: string) => Buffer.from(value, 'utf16le');
const hmacMD5 = (key: Uint8Array, ...data: Uint8Array[]) => {
  const hmac = createHmac('md5', key);
  for (const part of data) hmac.update(part);
  return hmac.digest();
};

/** The first message, sent as `Authorization: NTLM <base64>` to ask the server for a challenge. */
export function ntlmNegotiate(): string {
  const message = Buffer.alloc(32);
  SIGNATURE.copy(message, 0);
  message.writeUInt32LE(1, 8);
  message.writeUInt32LE(NEGOTIATE_FLAGS, 12);
  return `NTLM ${message.toString('base64')}`;
}

export interface NTLMChallenge {
  flags: number;
  serverChallenge: Buffer;
  targetName: string;
  targetInfo: Buffer;
}
/** Reads the server's challenge from a `WWW-Authenticate: NTLM <base64>` header. */
export function parseNTLMChallenge(header: string | null): NTLMChallenge | undefined {
  const token = header
    ?.split(',')
    .map((part) => part.trim())
    .find((part) => /^NTLM\s+\S/i.test(part))
    ?.slice(4)
    .trim();
  if (!token) return undefined;
  const message = Buffer.from(token, 'base64');
  if (message.length < 32 || !message.subarray(0, 8).equals(SIGNATURE)) return undefined;
  if (message.readUInt32LE(8) !== 2) return undefined;
  const field = (offset: number) => {
    if (message.length < offset + 8) return Buffer.alloc(0);
    const length = message.readUInt16LE(offset);
    const start = message.readUInt32LE(offset + 4);
    if (start + length > message.length) throw new Error('The NTLM challenge is malformed.');
    return message.subarray(start, start + length);
  };
  const flags = message.readUInt32LE(20);
  const name = field(12);
  return {
    flags,
    serverChallenge: Buffer.from(message.subarray(24, 32)),
    targetName: flags & NEGOTIATE_UNICODE ? name.toString('utf16le') : name.toString('latin1'),
    targetInfo: flags & NEGOTIATE_TARGET_INFO ? Buffer.from(field(40)) : Buffer.alloc(0),
  };
}

/** NTOWFv2: the NTLMv2 key from the password, user, and domain. */
export function ntowfv2(password: string, username: string, domain: string): Buffer {
  return hmacMD5(md4(utf16(password)), utf16(username.toUpperCase() + domain));
}

/** The server's timestamp from the challenge's target information, when it sent one. */
function targetTimestamp(targetInfo: Buffer): Buffer | undefined {
  for (let offset = 0; offset + 4 <= targetInfo.length;) {
    const id = targetInfo.readUInt16LE(offset);
    const length = targetInfo.readUInt16LE(offset + 2);
    if (id === 0) return undefined;
    if (id === 7 && length === 8) return targetInfo.subarray(offset + 4, offset + 12);
    offset += 4 + length;
  }
  return undefined;
}

export interface NTLMResponses {
  lm: Buffer;
  nt: Buffer;
}
/** The NTLMv2 and LMv2 responses to a challenge (MS-NLMP 3.3.2). */
export function ntlmv2Responses(
  key: Buffer,
  challenge: Pick<NTLMChallenge, 'serverChallenge' | 'targetInfo'>,
  clientChallenge: Buffer = randomBytes(8),
  now = Date.now(),
): NTLMResponses {
  const serverTime = targetTimestamp(challenge.targetInfo);
  const time = Buffer.alloc(8);
  if (serverTime) serverTime.copy(time);
  else time.writeBigUInt64LE((BigInt(now) + 11644473600000n) * 10000n);
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    time,
    clientChallenge,
    Buffer.alloc(4),
    challenge.targetInfo,
    Buffer.alloc(4),
  ]);
  const proof = hmacMD5(key, challenge.serverChallenge, temp);
  // With a server timestamp the LMv2 response is sent as zeros, as Windows does.
  const lm = serverTime
    ? Buffer.alloc(24)
    : Buffer.concat([hmacMD5(key, challenge.serverChallenge, clientChallenge), clientChallenge]);
  return { lm, nt: Buffer.concat([proof, temp]) };
}

export interface NTLMCredentials {
  username: string;
  password: string;
  domain?: string;
  workstation?: string;
}
/** The authenticate message answering a challenge, as an `Authorization` header value. */
export function ntlmAuthenticate(
  auth: NTLMCredentials,
  challenge: NTLMChallenge,
  clientChallenge?: Buffer,
  now?: number,
): string {
  // "DOMAIN\user" and "user@domain" are accepted as well as a separate domain.
  let username = auth.username;
  let domain = auth.domain ?? '';
  const slash = username.indexOf('\\');
  if (!domain && slash > 0)
    [domain, username] = [username.slice(0, slash), username.slice(slash + 1)];
  const { lm, nt } = ntlmv2Responses(
    ntowfv2(auth.password, username, domain),
    challenge,
    clientChallenge,
    now,
  );
  const unicode = (challenge.flags & NEGOTIATE_UNICODE) !== 0;
  const text = (value: string) => (unicode ? utf16(value) : Buffer.from(value, 'latin1'));
  const payloads = [text(domain), text(username), text(auth.workstation ?? ''), lm, nt];
  const header = Buffer.alloc(64);
  SIGNATURE.copy(header, 0);
  header.writeUInt32LE(3, 8);
  // Field order in the header: LM, NT, domain, user, workstation, session key.
  const order = [3, 4, 0, 1, 2];
  const offsets: number[] = [];
  let offset = header.length;
  for (const payload of payloads) {
    offsets.push(offset);
    offset += payload.length;
  }
  order.forEach((index, slot) => {
    header.writeUInt16LE(payloads[index].length, 12 + slot * 8);
    header.writeUInt16LE(payloads[index].length, 14 + slot * 8);
    header.writeUInt32LE(offsets[index], 16 + slot * 8);
  });
  header.writeUInt32LE(offset, 52 + 4);
  const shared = challenge.flags & NEGOTIATE_FLAGS & ~(NEGOTIATE_UNICODE | NEGOTIATE_OEM);
  header.writeUInt32LE((shared | (unicode ? NEGOTIATE_UNICODE : NEGOTIATE_OEM)) >>> 0, 60);
  return `NTLM ${Buffer.concat([header, ...payloads]).toString('base64')}`;
}
