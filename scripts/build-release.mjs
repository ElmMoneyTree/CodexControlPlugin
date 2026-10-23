import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const releaseRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginRoot = path.join(releaseRoot, 'plugins', 'codex-control-plugin');
const sourceRoot = path.resolve(releaseRoot, '..', 'CodexControlPluginCode');
const manifestPath = path.join(releaseRoot, 'build-manifest.json');
const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const archiveFile = `codex-control-plugin-${pluginManifest.version.split('+')[0]}.zip`;
const outputPath = path.join(releaseRoot, 'dist', archiveFile);
const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const sourceCommit = git(sourceRoot, ['rev-parse', 'HEAD']);
const sourceTreeState = git(sourceRoot, ['status', '--porcelain']) ? 'working-tree' : 'clean';
const files = walk(pluginRoot).map(file => {
  const data = fs.readFileSync(file);
  return {
    path: path.relative(pluginRoot, file).split(path.sep).join('/'),
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
});

const manifest = {
  name: pluginManifest.name,
  version: pluginManifest.version,
  baseVersion: pluginManifest.version.split('+')[0],
  builtAt: new Date().toISOString(),
  sourceCommit,
  sourceTreeState,
  archiveFile,
  platforms: ['win32-x64', 'darwin-arm64', 'darwin-x64'],
  nodeVersion: previous.nodeVersion,
  files,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-control-plugin-release-'));
try {
  for (const relative of [
    '.agents',
    'plugins',
    'README.md',
    'README.zh-CN.md',
    'PLUGIN-INSTALL.zh-CN.md',
    'build-manifest.json',
  ]) {
    fs.cpSync(path.join(releaseRoot, relative), path.join(stage, relative), { recursive: true });
  }
  fs.rmSync(outputPath, { force: true });
  const zipped = spawnSync('zip', [
    '-qr', outputPath,
    '.agents', 'plugins', 'README.md', 'README.zh-CN.md', 'PLUGIN-INSTALL.zh-CN.md', 'build-manifest.json',
  ], { cwd: stage, encoding: 'utf8' });
  if (zipped.status !== 0) throw new Error(zipped.stderr || zipped.stdout || 'zip failed');
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

const archive = fs.readFileSync(outputPath);
const archiveHash = crypto.createHash('sha256').update(archive).digest('hex');
fs.writeFileSync(`${outputPath}.sha256`, `${archiveHash}  ${path.basename(outputPath)}\n`);
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  files: files.length,
  bytes: archive.length,
  sha256: archiveHash,
})}\n`);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    })
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
