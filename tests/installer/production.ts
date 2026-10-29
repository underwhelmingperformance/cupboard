import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';
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

// Compare booleans, counts and modes only, so a failure never prints the token.
const token = env.GITHUB_ACCESS_TOKEN;
assert.ok(token, 'The production trial must set GITHUB_ACCESS_TOKEN');
const configHome =
	env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === ''
		? path.join(homedir(), '.config')
		: env.XDG_CONFIG_HOME;
const configuration = path.join(configHome, 'nix');
const tokenFile = path.join(configuration, 'github-access-token.conf');
const netrc = path.join(homedir(), '.netrc');
const { stdout: accessTokens } = await promisify(execFile)('nix', [
	'config',
	'show',
	'access-tokens'
]);
const tokenStatus = await stat(tokenFile);
const nixConfig = await readFile(path.join(configuration, 'nix.conf'), 'utf8');
const netrcStatus = await stat(netrc);
const netrcContents = await readFile(netrc, 'utf8');
assert.deepEqual(
	{
		tokenFileMode: tokenStatus.mode & 0o777,
		nixConfHasToken: nixConfig.includes('access-tokens'),
		netrcMode: netrcStatus.mode & 0o777,
		netrcGithubEntries: netrcContents.split('machine github.com\n').length - 1,
		netrcHasJobToken: netrcContents.includes(
			`machine github.com\nlogin github-token\npassword ${token}\n`
		),
		nixReadsJobToken: accessTokens.trim() === `github.com=${token}`
	},
	{
		tokenFileMode: 0o600,
		nixConfHasToken: false,
		netrcMode: 0o600,
		netrcGithubEntries: 1,
		netrcHasJobToken: true,
		nixReadsJobToken: true
	}
);
