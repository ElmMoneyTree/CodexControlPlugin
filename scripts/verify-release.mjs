import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const releaseRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'build-manifest.json'), 'utf8'));
const archive = path.join(releaseRoot, 'dist', manifest.archiveFile ?? 'codex-control-plugin-windows-x64-0.2.0.zip');
const rootFiles = [
  '.agents/plugins/marketplace.json',
  'README.md',
  'README.zh-CN.md',
  'PLUGIN-INSTALL.zh-CN.md',
  'build-manifest.json',
];
const expected = [
  ...rootFiles,
  ...manifest.files.map(item => `plugins/${manifest.name}/${item.path}`),
].sort();

const listing = unzip(['-Z1', archive]).toString('utf8')
  .split(/\r?\n/)
  .filter(name => name && !name.endsWith('/'))
  .sort();
assert.deepEqual(listing, expected, 'archive contains missing or undeclared files');

for (const item of manifest.files) {
  const entry = `plugins/${manifest.name}/${item.path}`;
  const data = unzip(['-p', archive, entry]);
  assert.equal(data.length, item.bytes, `${entry} byte count does not match manifest`);
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), item.sha256, `${entry} hash does not match manifest`);
}
for (const relative of rootFiles) {
  const data = unzip(['-p', archive, relative]);
  assert.equal(
    crypto.createHash('sha256').update(data).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseRoot, relative))).digest('hex'),
    `${relative} differs from the release tree`,
  );
}

const archiveData = fs.readFileSync(archive);
process.stdout.write(`${JSON.stringify({
  ok: true,
  files: listing.length,
  bytes: archiveData.length,
  sha256: crypto.createHash('sha256').update(archiveData).digest('hex'),
})}\n`);

function unzip(args) {
  const result = spawnSync('unzip', args, { encoding: null, maxBuffer: 150 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.toString('utf8') || `unzip ${args.join(' ')} failed`);
  return result.stdout;
}
