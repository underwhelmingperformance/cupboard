import { spawn } from 'node:child_process';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { collectProcess } from './process.ts';

const delayedInheritedOutput = [
	"const { spawn } = require('node:child_process');",
	`const descendant = spawn(${JSON.stringify(process.execPath)}, [`,
	"\t'-e',",
	`\t${JSON.stringify("setTimeout(() => process.stdout.write('late output'), 250)")}`,
	'], {',
	'\tdetached: true,',
	"\tstdio: ['ignore', process.stdout, 'ignore']",
	'});',
	'descendant.unref();'
].join('\n');

describe('collectProcess', () => {
	it('waits for inherited output streams to close', async () => {
		const child = spawn(process.execPath, ['-e', delayedInheritedOutput], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		await expect(
			collectProcess(process.execPath, ['-e', delayedInheritedOutput], child)
		).resolves.toStrictEqual({ stdout: 'late output', stderr: '' });
	});
});
