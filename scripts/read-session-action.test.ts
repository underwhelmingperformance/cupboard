import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
	new URL('../actions/read-session.sh', import.meta.url)
);

describe('run_with_read_session', () => {
	it('runs public commands directly and quotes private targets and views', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-read-shell-')
		);
		const binary = path.join(directory, 'cupboard');
		const trace = path.join(directory, 'trace');

		try {
			await writeFile(
				binary,
				'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$TRACE_FILE"\n',
				{
					mode: 0o700
				}
			);
			const publicRun = await execFileAsync(
				'bash',
				[
					'-c',
					'source "$SCRIPT"; run_with_read_session "$BINARY" "" "" -- printf "%s" "public path"'
				],
				{ env: { ...process.env, SCRIPT: script, BINARY: binary } }
			);
			await execFileAsync(
				'bash',
				[
					'-c',
					'source "$SCRIPT"; run_with_read_session "$BINARY" "$TARGET" "$VIEW" -- printf "%s" "private path"'
				],
				{
					env: {
						...process.env,
						SCRIPT: script,
						BINARY: binary,
						TRACE_FILE: trace,
						TARGET: 'https://cache.example/t/acme/cache/a b',
						VIEW: 'a b'
					}
				}
			);

			const privateTrace = await readFile(trace, 'utf8');
			expect({
				publicOutput: publicRun.stdout,
				privateArguments: privateTrace.trimEnd().split('\n')
			}).toStrictEqual({
				publicOutput: 'public path',
				privateArguments: [
					'run',
					'https://cache.example/t/acme/cache/a b',
					'--github-oidc',
					'--reuse-view',
					'a b',
					'--',
					'printf',
					'%s',
					'private path'
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
