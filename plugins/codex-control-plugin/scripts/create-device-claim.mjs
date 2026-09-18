import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const DEVICE_CLAIM_PROOF_CONTEXT = 'codex-control-device-claim-v1';

export function createDeviceProof(deviceName) {
  const name = String(deviceName ?? '').trim();
  if (!name || name.length > 200) throw new Error('Device name is invalid.');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  if (!publicJwk.x) throw new Error('Unable to export the device public key.');
  const nonce = randomBytes(24).toString('base64url');
  const message = `${DEVICE_CLAIM_PROOF_CONTEXT}\n${publicJwk.x}\n${nonce}\n${name}`;
  const proof = sign(null, Buffer.from(message), privateKey).toString('base64url');
  return {
    deviceName: name,
    devicePublicKey: publicJwk.x,
    nonce,
    proof,
    privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

export async function requestDeviceClaim({ relayUrl, deviceName, accountLabel = '', deviceToken = '', fetchImpl = fetch }) {
  const origin = relayOrigin(relayUrl);
  const generated = createDeviceProof(deviceName);
  const response = await fetchImpl(`${origin}/v1/device-claims`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}),
    },
    body: JSON.stringify({
      deviceName: generated.deviceName,
      accountLabel: String(accountLabel ?? '').trim() || undefined,
      devicePublicKey: generated.devicePublicKey,
      nonce: generated.nonce,
      proof: generated.proof,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Connection service returned HTTP ${response.status}`);
  for (const field of ['id', 'claimSecret', 'pollToken', 'claimUrl', 'deviceKeyFingerprint', 'expiresAt']) {
    if (value[field] == null || value[field] === '') throw new Error(`Connection service response is missing ${field}`);
  }
  return { ...value, relayUrl: origin, deviceName: generated.deviceName, devicePublicKey: generated.devicePublicKey, privateKeyPkcs8: generated.privateKeyPkcs8 };
}

function relayOrigin(value) {
  const url = new URL(String(value ?? '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Connection service URL must be an HTTP(S) origin.');
  }
  return url.origin;
}

function parseArguments(argv) {
  const result = { relayUrl: '', deviceName: '', accountLabel: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index], value = argv[index + 1];
    if (!['--relay-url', '--device-name', '--account-label'].includes(key) || value == null) throw new Error(`Invalid argument: ${key}`);
    if (key === '--relay-url') result.relayUrl = value;
    if (key === '--device-name') result.deviceName = value;
    if (key === '--account-label') result.accountLabel = value;
    index += 1;
  }
  if (!result.relayUrl || !result.deviceName) throw new Error('--relay-url and --device-name are required.');
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await requestDeviceClaim({
      ...parseArguments(process.argv.slice(2)),
      deviceToken: process.env.CODEX_CONTROL_LEGACY_DEVICE_TOKEN ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
