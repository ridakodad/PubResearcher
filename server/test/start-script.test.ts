import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm start` passe par scripts/ensure-build.mjs (script `prestart`). Sans lui, démarrer avant d'avoir compilé donnait
 * « Cannot find module … dist/index.js », une trace que rien n'explique à qui n'est pas développeur.
 */
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/ensure-build.mjs');

/** Un faux projet : `build.cjs` crée les deux sorties compilées (ou échoue), et laisse une trace de son passage. */
function fakeProject(options: { built: boolean; buildExit?: number }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-start-'));
  fs.writeFileSync(
    path.join(dir, 'build.cjs'),
    `const fs = require('node:fs');
fs.writeFileSync('build-ran', '');
if (${options.buildExit ?? 0} !== 0) process.exit(${options.buildExit ?? 0});
fs.mkdirSync('server/dist', { recursive: true });
fs.mkdirSync('web/dist', { recursive: true });
fs.writeFileSync('server/dist/index.js', '');
fs.writeFileSync('web/dist/index.html', '');
`,
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'faux', version: '0.0.0', scripts: { build: 'node build.cjs' } }));
  if (options.built) {
    fs.mkdirSync(path.join(dir, 'server/dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'web/dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server/dist/index.js'), '');
    fs.writeFileSync(path.join(dir, 'web/dist/index.html'), '');
  }
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], { env: { ...process.env, RT_ROOT: dir, ...env }, encoding: 'utf8', timeout: 60_000 });
}

describe('npm start : compilation automatique à la première utilisation', () => {
  test('déjà compilée : rien à faire, rien d’affiché', () => {
    const dir = fakeProject({ built: true });
    const result = run(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(path.join(dir, 'build-ran')), false, 'une application compilée ne doit pas être recompilée');
  });

  test('pas encore compilée : elle l’est, puis le démarrage peut suivre', () => {
    const dir = fakeProject({ built: false });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Première utilisation/);
    assert.match(result.stdout, /Compilation terminée/);
    assert.ok(fs.existsSync(path.join(dir, 'server/dist/index.js')));
    assert.ok(fs.existsSync(path.join(dir, 'web/dist/index.html')));
  });

  test('une moitié compilée seulement (le serveur sans l’interface) est refaite', () => {
    const dir = fakeProject({ built: false });
    fs.mkdirSync(path.join(dir, 'server/dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server/dist/index.js'), '');
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'build-ran')));
    assert.ok(fs.existsSync(path.join(dir, 'web/dist/index.html')));
  });

  test('compilation en échec : arrêt net, avec les causes fréquentes et le remède', () => {
    const dir = fakeProject({ built: false, buildExit: 3 });
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /La compilation a échoué/);
    assert.match(result.stderr, /npm ci/);
    assert.match(result.stderr, /--omit=dev/);
  });
});

describe('npm start : version de Node', () => {
  test('trop ancienne : une phrase qui dit quoi installer, et rien n’est compilé', () => {
    for (const version of ['20.11.0', 'v18.19.1', '22.12.9']) {
      const dir = fakeProject({ built: false });
      const result = run(dir, { RT_FAKE_NODE_VERSION: version });
      assert.equal(result.status, 1, version);
      assert.match(result.stderr, /Node\.js 22\.13 ou plus récent/);
      assert.match(result.stderr, new RegExp(`détectée est ${version.replace(/^v/, '').replace(/\./g, '\\.')}`));
      assert.match(result.stderr, /nodejs\.org/);
      assert.equal(fs.existsSync(path.join(dir, 'build-ran')), false, version);
    }
  });

  test('suffisante, ou illisible : le démarrage continue', () => {
    for (const version of ['22.13.0', '24.1.0', '', 'inconnue']) {
      const dir = fakeProject({ built: true });
      const result = run(dir, { RT_FAKE_NODE_VERSION: version });
      assert.equal(result.status, 0, `${version} : ${result.stderr}`);
    }
  });

  test('la version de Node qui exécute les tests convient', () => {
    const dir = fakeProject({ built: true });
    assert.equal(run(dir).status, 0);
  });
});
