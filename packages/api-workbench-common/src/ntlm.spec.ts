import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  md4,
  ntlmAuthenticate,
  ntlmNegotiate,
  ntlmv2Responses,
  ntowfv2,
  parseNTLMChallenge,
} from './ntlm';

test('MD4 matches the RFC 1320 test suite', () => {
  const vectors: [string, string][] = [
    ['', '31d6cfe0d16ae931b73c59d7e0c089c0'],
    ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
    ['abc', 'a448017aaf21d8525fc10ae87aa6729d'],
    ['message digest', 'd9130a8164549fe818874806e1c7014b'],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      'e33b4ddc9c38f2199c3e7b164fcc0536',
    ],
  ];
  for (const [input, digest] of vectors)
    assert.equal(md4(Buffer.from(input)).toString('hex'), digest, input);
});

// MS-NLMP 4.2.4: NTLMv2 authentication with User / Domain / Password.
const targetInfo = Buffer.from(
  '02000c0044006f006d00610069006e0001000c0053006500720076006500720000000000',
  'hex',
);
const serverChallenge = Buffer.from('0123456789abcdef', 'hex');
const clientChallenge = Buffer.from('aaaaaaaaaaaaaaaa', 'hex');

test('NTLMv2 responses match the MS-NLMP example', () => {
  const key = ntowfv2('Password', 'User', 'Domain');
  assert.equal(key.toString('hex'), '0c868a403bfd7a93a3001ef22ef02e3f');
  // The example's timestamp is zero: 11644473600000 ms before the Unix epoch.
  const { lm, nt } = ntlmv2Responses(
    key,
    { serverChallenge, targetInfo },
    clientChallenge,
    -11644473600000,
  );
  assert.equal(lm.toString('hex'), '86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa');
  assert.equal(nt.subarray(0, 16).toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c');
});

test('NTLM messages negotiate, parse a challenge, and authenticate', () => {
  const negotiate = Buffer.from(ntlmNegotiate().slice(5), 'base64');
  assert.equal(negotiate.subarray(0, 8).toString('latin1'), 'NTLMSSP\0');
  assert.equal(negotiate.readUInt32LE(8), 1);

  const name = Buffer.from('Domain', 'utf16le');
  const challengeMessage = Buffer.alloc(48 + name.length + targetInfo.length);
  challengeMessage.write('NTLMSSP\0', 0, 'latin1');
  challengeMessage.writeUInt32LE(2, 8);
  challengeMessage.writeUInt16LE(name.length, 12);
  challengeMessage.writeUInt16LE(name.length, 14);
  challengeMessage.writeUInt32LE(48, 16);
  challengeMessage.writeUInt32LE(0x00890205, 20);
  serverChallenge.copy(challengeMessage, 24);
  challengeMessage.writeUInt16LE(targetInfo.length, 40);
  challengeMessage.writeUInt16LE(targetInfo.length, 42);
  challengeMessage.writeUInt32LE(48 + name.length, 44);
  name.copy(challengeMessage, 48);
  targetInfo.copy(challengeMessage, 48 + name.length);
  const challenge = parseNTLMChallenge(`Negotiate, NTLM ${challengeMessage.toString('base64')}`);
  assert.ok(challenge);
  assert.equal(challenge.targetName, 'Domain');
  assert.deepEqual(challenge.serverChallenge, serverChallenge);
  assert.deepEqual(challenge.targetInfo, targetInfo);
  assert.equal(parseNTLMChallenge('Basic realm="x"'), undefined);
  assert.equal(parseNTLMChallenge('NTLM'), undefined);

  const message = Buffer.from(
    ntlmAuthenticate(
      { username: 'Domain\\User', password: 'Password', workstation: 'COMPUTER' },
      challenge,
      clientChallenge,
      -11644473600000,
    ).slice(5),
    'base64',
  );
  assert.equal(message.readUInt32LE(8), 3);
  const field = (offset: number) => {
    const length = message.readUInt16LE(offset);
    const start = message.readUInt32LE(offset + 4);
    return message.subarray(start, start + length);
  };
  assert.equal(field(28).toString('utf16le'), 'Domain');
  assert.equal(field(36).toString('utf16le'), 'User');
  assert.equal(field(44).toString('utf16le'), 'COMPUTER');
  assert.equal(field(20).subarray(0, 16).toString('hex'), '68cd0ab851e51c96aabc927bebef6a1c');
  assert.ok(message.readUInt32LE(60) & 1, 'Unicode is negotiated');
});
