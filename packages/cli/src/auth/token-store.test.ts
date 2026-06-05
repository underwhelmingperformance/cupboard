import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCachedToken, writeCachedToken } from './token-store.ts';

async function scratchDirectory(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'cupboard-token-'));
}

describe('token cache', () => {
	it('round-trips a token, creating the directory, readable only by the owner', async () => {
		const target = path.join(await scratchDirectory(), 'cupboard', 'token');

		await writeCachedToken('admin.jwt', target);
		const token = await readCachedToken(target);
		const stats = await stat(target);

		expect({ token, mode: stats.mode & 0o777 }).toStrictEqual({
			token: 'admin.jwt',
			mode: 0o600
		});
	});

	it('returns undefined when no token is cached', async () => {
		const target = path.join(await scratchDirectory(), 'absent');

		expect(await readCachedToken(target)).toBeUndefined();
	});
});
