import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..');
const repoRoot = path.join(pluginRoot, '..');
const sandboxDir = path.join(os.tmpdir(), `claudian_wechat_sandbox_${Date.now()}`);

function sha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
}

console.log('=== [1/4] Checking Repository Metadata Consistency ===');
const rootManifestPath = path.join(repoRoot, 'manifest.json');
const pluginManifestPath = path.join(pluginRoot, 'manifest.json');
const packageJsonPath = path.join(pluginRoot, 'package.json');

assert(fs.existsSync(rootManifestPath), 'Root manifest.json exists (required by Obsidian Releases CI)');
const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

assert(rootManifest.id === 'claudian-wechat', 'Manifest id is claudian-wechat');
assert(rootManifest.version === pluginManifest.version, `Manifest versions match (${rootManifest.version})`);
assert(pkgJson.version === rootManifest.version, `package.json version matches manifest (${pkgJson.version})`);

console.log('\n=== [2/4] Testing Fresh Install Simulation (Obsidian Store Vacuum) ===');
if (fs.existsSync(sandboxDir)) {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
}
fs.mkdirSync(sandboxDir, { recursive: true });

// Copy ONLY main.js and manifest.json (simulating Obsidian store download)
fs.copyFileSync(path.join(pluginRoot, 'main.js'), path.join(sandboxDir, 'main.js'));
fs.copyFileSync(path.join(pluginRoot, 'manifest.json'), path.join(sandboxDir, 'manifest.json'));

assert(!fs.existsSync(path.join(sandboxDir, 'relay.py')), 'relay.py is initially absent');
assert(!fs.existsSync(path.join(sandboxDir, 'strings.json')), 'strings.json is initially absent');

// Execute mock runner that loads main.js and triggers ensureEmbeddedAssets
const runnerScript = `
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Mock external Obsidian runtime module
const origRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'obsidian') {
    return new Proxy({}, {
      get(target, prop) {
        if (prop === '__esModule') return false;
        return class DummyClass {
          constructor(...args) {}
          open() {}
          close() {}
        };
      }
    });
  }
  return origRequire.apply(this, arguments);
};

// Mock Obsidian environment
const mockApp = { vault: { adapter: { getBasePath: () => __dirname } } };
const mockManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));

// Require the compiled bundle
const PluginClass = require('./main.js').default;
const pluginInstance = new PluginClass(mockApp, mockManifest);
pluginInstance.pluginDir = __dirname;

// Run the self-extraction method
pluginInstance.ensureEmbeddedAssets().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
`;

fs.writeFileSync(path.join(sandboxDir, '_runner.js'), runnerScript, 'utf8');
execSync(`node _runner.js`, { cwd: sandboxDir, stdio: 'inherit' });

// Verify extracted assets
const srcRelayHash = sha256(path.join(pluginRoot, 'relay.py'));
const extractedRelayHash = sha256(path.join(sandboxDir, 'relay.py'));
assert(srcRelayHash === extractedRelayHash, `Extracted relay.py SHA256 matches source exactly (${srcRelayHash.slice(0, 12)}...)`);

const srcStringsHash = sha256(path.join(pluginRoot, 'strings.json'));
const extractedStringsHash = sha256(path.join(sandboxDir, 'strings.json'));
assert(srcStringsHash === extractedStringsHash, `Extracted strings.json SHA256 matches source exactly (${srcStringsHash.slice(0, 12)}...)`);

// Validate Python syntax on extracted relay.py
execSync(`python -m py_compile relay.py`, { cwd: sandboxDir, stdio: 'inherit' });
console.log('  ✓ python -m py_compile on extracted relay.py succeeded with zero syntax errors');

// Validate Python runtime invocation
const pyHelpOutput = execSync(`python relay.py --help`, { cwd: sandboxDir, encoding: 'utf8' });
assert(pyHelpOutput.includes('Usage: python relay.py'), 'python relay.py --help runs and returns valid CLI usage');

// Validate strings.json AST
const parsedStrings = JSON.parse(fs.readFileSync(path.join(sandboxDir, 'strings.json'), 'utf8'));
assert(Boolean(parsedStrings.emptyText && parsedStrings.tabNotReady), 'Extracted strings.json is valid and contains expected keys');

console.log('\n=== [3/4] Testing Incremental Update / Hash Overwrite ===');
// Corrupt existing on-disk assets to simulate older version installed previously
fs.writeFileSync(path.join(sandboxDir, 'relay.py'), '# OLD OBSOLETE RELAY CODE', 'utf8');
fs.writeFileSync(path.join(sandboxDir, 'strings.json'), '{"obsolete": true}', 'utf8');

assert(sha256(path.join(sandboxDir, 'relay.py')) !== srcRelayHash, 'Corrupted relay.py hash differs from target');

// Run self-extraction again (simulating plugin update / reload)
execSync(`node _runner.js`, { cwd: sandboxDir, stdio: 'inherit' });

const updatedRelayHash = sha256(path.join(sandboxDir, 'relay.py'));
const updatedStringsHash = sha256(path.join(sandboxDir, 'strings.json'));
assert(updatedRelayHash === srcRelayHash, 'Outdated relay.py automatically overwritten with new version');
assert(updatedStringsHash === srcStringsHash, 'Outdated strings.json automatically overwritten with new version');

console.log('\n=== [4/4] Cleanup Sandbox ===');
fs.rmSync(sandboxDir, { recursive: true, force: true });
console.log('  ✓ Test sandbox cleaned up');

console.log('\n🎉 ALL AUTOMATED VERIFICATION TESTS PASSED (100% SUCCESS)\n');
