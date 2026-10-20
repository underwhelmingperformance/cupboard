import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { Nix } from '../../packages/nix/src/nix.ts';

const versions = await readFile(
	new URL('../../actions/install-nix/versions.env', import.meta.url),
	'utf8'
);
const version = /^nix_version=(\S+)$/mu.exec(versions)?.[1];
assert.ok(version, 'The production installer must specify nix_version');
const { stdout } = await promisify(execFile)('nix', ['--version']);
assert.deepEqual(
	{ kind: Nix.open().storeKind, version: stdout.trim() },
	{
		kind: 'local-filesystem',
		version: `nix (Nix) ${version}`
	}
);
