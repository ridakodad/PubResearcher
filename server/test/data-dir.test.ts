/**
 * Emplacement des données : `data/` depuis les sources, le dossier de l'utilisateur pour la version prête à l'emploi
 * (une mise à jour remplace le dossier de l'application, pas les dossiers patients), `DATA_DIR` dans tous les cas.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_MARKER, launchHints, readPackageInfo, resolveDataDir, userDataDir } from '../src/lib/data-dir.js';

const base = { env: {}, homedir: '/home/alice', repoRoot: '/opt/pubresearcher', packaged: false } as const;

describe('dossier de données par défaut', () => {
  test('depuis les sources : data/ à la racine du dépôt, comme avant', () => {
    assert.equal(resolveDataDir({ ...base, platform: 'linux' }), path.join('/opt/pubresearcher', 'data'));
    assert.equal(resolveDataDir({ ...base, platform: 'win32' }), path.join('/opt/pubresearcher', 'data'));
  });

  test('version empaquetée : hors du dossier de l’application, selon le système', () => {
    const packaged = { ...base, packaged: true };
    assert.equal(
      resolveDataDir({ ...packaged, platform: 'win32', homedir: 'C:\\Users\\alice', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } }),
      'C:\\Users\\alice\\AppData\\Local\\PubResearcher',
    );
    assert.equal(resolveDataDir({ ...packaged, platform: 'darwin', homedir: '/Users/alice' }), '/Users/alice/Library/Application Support/PubResearcher');
    assert.equal(resolveDataDir({ ...packaged, platform: 'linux' }), '/home/alice/.local/share/pubresearcher');
  });

  test('Windows sans LOCALAPPDATA : le dossier local du profil', () => {
    assert.equal(userDataDir({}, 'win32', 'C:\\Users\\alice'), 'C:\\Users\\alice\\AppData\\Local\\PubResearcher');
    assert.equal(userDataDir({ LOCALAPPDATA: '  ' }, 'win32', 'C:\\Users\\alice'), 'C:\\Users\\alice\\AppData\\Local\\PubResearcher');
  });

  test('Linux : XDG_DATA_HOME respecté s’il est absolu, ignoré sinon', () => {
    assert.equal(userDataDir({ XDG_DATA_HOME: '/srv/donnees' }, 'linux', '/home/alice'), '/srv/donnees/pubresearcher');
    assert.equal(userDataDir({ XDG_DATA_HOME: 'relatif' }, 'linux', '/home/alice'), '/home/alice/.local/share/pubresearcher');
  });

  test('DATA_DIR l’emporte toujours (et un DATA_DIR vide vaut « non défini »)', () => {
    const dir = path.join(os.tmpdir(), 'ailleurs');
    assert.equal(resolveDataDir({ ...base, platform: 'linux', packaged: true, env: { DATA_DIR: dir } }), dir);
    assert.equal(resolveDataDir({ ...base, platform: 'linux', packaged: false, env: { DATA_DIR: dir } }), dir);
    assert.equal(resolveDataDir({ ...base, platform: 'linux', packaged: true, env: { DATA_DIR: '  ' } }), '/home/alice/.local/share/pubresearcher');
  });
});

describe('repérage de la version empaquetée', () => {
  test('le fichier pubresearcher-package.json la signale ; son absence ou un contenu illisible, non', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-pkg-'));
    try {
      assert.equal(readPackageInfo(root), null);
      fs.writeFileSync(path.join(root, PACKAGE_MARKER), '{pas du json');
      assert.equal(readPackageInfo(root), null);
      fs.writeFileSync(path.join(root, PACKAGE_MARKER), JSON.stringify({ version: '1.5.0', target: 'linux-x64', node: '22.23.3' }));
      assert.deepEqual(readPackageInfo(root), { version: '1.5.0', target: 'linux-x64', node: '22.23.3' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('les messages de démarrage parlent du lanceur, pas de « npm start », dans la version empaquetée', () => {
    assert.match(launchHints(false, 'linux').secondInstance, /npm start/);
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const hints = launchHints(true, platform);
      assert.doesNotMatch(hints.relaunch + hints.secondInstance, /npm/);
      assert.match(hints.secondInstance, /PORT=4100/);
    }
    assert.match(launchHints(true, 'win32').relaunch, /PubResearcher\.cmd/);
    assert.match(launchHints(true, 'darwin').relaunch, /PubResearcher\.command/);
    assert.match(launchHints(true, 'linux').relaunch, /pubresearcher\.sh/);
  });
});
