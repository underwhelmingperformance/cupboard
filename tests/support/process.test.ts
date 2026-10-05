import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { withInheritedStream } from './inherited-stream.ts';
import { collectProcess } from './process.ts';

describe('collectProcess', () => {
	it('waits for inherited output streams to close', async () => {
		await withInheritedStream('stdout', 'late output', async (fixture) => {
			const collected = collectProcess(
				process.execPath,
				fixture.arguments,
				fixture.child
			);
			await fixture.releaseAfterParentExit();
			await expect(collected).resolves.toStrictEqual({
				stdout: 'late output',
				stderr: ''
			});
		});
	});
});
