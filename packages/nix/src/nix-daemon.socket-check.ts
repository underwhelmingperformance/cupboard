import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import process from 'node:process';

import {
	NixDaemonConnectionError,
	NixDaemonStoreClient
} from './nix-daemon.ts';

const socketPath =
	process.env.NIX_DAEMON_SOCKET_PATH ?? '/nix/var/nix/daemon-socket/socket';

if (existsSync(socketPath)) {
	try {
		const client = new NixDaemonStoreClient({ socketPath });
		const substitutable = await client.querySubstitutablePaths([]);
		const valid = await client.queryValidPaths([]);
		const executableStorePath = /^\/nix\/store\/[^/]+/u.exec(
			process.execPath
		)?.[0];

		assert.deepStrictEqual(substitutable, []);
		assert.deepStrictEqual(valid, []);

		if (executableStorePath !== undefined) {
			const infos = await client.queryValidPathsInfo([
				executableStorePath,
				'/nix/store/00000000000000000000000000000000-cupboard-missing'
			]);

			assert.deepStrictEqual(
				infos.map((info) => info.storePath),
				[executableStorePath]
			);
		}
	} catch (error) {
		const cause =
			error instanceof NixDaemonConnectionError &&
			error.cause instanceof Error &&
			'code' in error.cause
				? error.cause.code
				: undefined;

		if (cause !== 'EPERM' || process.env.CI !== undefined) {
			throw error;
		}
	}
}
