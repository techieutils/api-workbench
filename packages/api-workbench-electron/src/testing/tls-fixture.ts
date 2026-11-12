import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function createTLSFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-workbench-tls-'));
  const file = (name: string) => path.join(directory, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
  try {
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('ca.key'),
      '-out',
      file('ca.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=API Workbench Test Root/O=API Workbench Tests',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('server.key'),
      '-out',
      file('server.csr'),
      '-subj',
      '/CN=localhost/O=API Workbench Tests',
    ]);
    await writeFile(
      file('extensions.cnf'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    );
    openssl([
      'x509',
      '-req',
      '-in',
      file('server.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file('server.pem'),
      '-days',
      '2',
      '-extfile',
      file('extensions.cnf'),
    ]);
    // Client certificate for mutual TLS tests, as PEM files and a passphrase-protected PKCS#12 bundle.
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      file('client.key'),
      '-out',
      file('client.csr'),
      '-subj',
      '/CN=workbench-client/O=API Workbench Tests',
    ]);
    await writeFile(
      file('client.cnf'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
    );
    openssl([
      'x509',
      '-req',
      '-in',
      file('client.csr'),
      '-CA',
      file('ca.pem'),
      '-CAkey',
      file('ca.key'),
      '-CAcreateserial',
      '-out',
      file('client.pem'),
      '-days',
      '2',
      '-extfile',
      file('client.cnf'),
    ]);
    openssl([
      'pkcs12',
      '-export',
      '-inkey',
      file('client.key'),
      '-in',
      file('client.pem'),
      '-out',
      file('client.p12'),
      '-passout',
      'pass:p12-secret',
    ]);
    return {
      clientCertPath: file('client.pem'),
      clientKeyPath: file('client.key'),
      clientPfxPath: file('client.p12'),
      serverKeyPath: file('server.key'),
      ca: await readFile(file('ca.pem'), 'utf8'),
      cert: await readFile(file('server.pem'), 'utf8'),
      key: await readFile(file('server.key'), 'utf8'),
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
