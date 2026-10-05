import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTemporaryDirectory } from './filesystem.ts';

const vitestEntry = path.resolve('node_modules/vitest/vitest.mjs');
const reporterPath = path.resolve('tests/support/strict-e2e-reporter.ts');

describe('strict end-to-end results', () => {
	it.each([
		{
			case: 'passing cases',
			source: "it('runs', () => expect(true).toBe(true));",
			expectedCode: 0,
			expectedSkipped: false
		},
		{
			case: 'a skipped suite',
			source:
				"describe.skip('missing daemon', () => { it('runs', () => {}); });",
			expectedCode: 1,
			expectedSkipped: true
		},
		{
			case: 'a dynamic skip',
			source: "it('untrusted daemon', (context) => { context.skip(); });",
			expectedCode: 1,
			expectedSkipped: true
		}
	])(
		'rejects unexpected skips in $case',
		async ({ source, expectedCode, expectedSkipped }) => {
			await withTemporaryDirectory(
				'cupboard-strict-tests-',
				async (directory) => {
					const testPath = path.join(directory, 'fixture.test.ts');
					const configPath = path.join(directory, 'vitest.config.ts');
					await writeFile(
						testPath,
						`import { describe, expect, it } from ${JSON.stringify(path.resolve('node_modules/vitest/dist/index.js'))};\n${source}\n`
					);
					await writeFile(
						configPath,
						`export default { test: { root: ${JSON.stringify(directory)}, include: ['fixture.test.ts'], reporters: ['default', ${JSON.stringify(reporterPath)}], maxWorkers: 1 } };\n`
					);
					const child = spawn(
						process.execPath,
						[vitestEntry, 'run', '--config', configPath],
						{
							stdio: ['ignore', 'pipe', 'pipe'],
							signal: AbortSignal.timeout(30_000)
						}
					);
					const output: Buffer[] = [];
					child.stdout.on('data', (chunk: Buffer) => {
						output.push(chunk);
					});
					child.stderr.on('data', (chunk: Buffer) => {
						output.push(chunk);
					});
					const code = await new Promise<number | null>((resolve, reject) => {
						child.once('error', reject);
						child.once('close', resolve);
					});

					expect({
						code,
						rejectedSkip: Buffer.concat(output)
							.toString('utf8')
							.includes('Unexpected skipped end-to-end tests:')
					}).toStrictEqual({
						code: expectedCode,
						rejectedSkip: expectedSkipped
					});
				}
			);
		},
		60_000
	);
});
