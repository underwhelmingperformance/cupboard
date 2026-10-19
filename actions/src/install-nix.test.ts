import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';

const installer = fileURLToPath(
	new URL('../install-nix/install.sh', import.meta.url)
);

function run(script: string, environment: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(
		'bash',
		['-euc', `source "$1"\n${script}`, 'install-nix-test', installer],
		{
			encoding: 'utf8',
			env: { ...process.env, ...environment }
		}
	);

	if (result.error !== undefined) {
		throw result.error;
	}

	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr
	};
}

const darwinCommands = `
stat() { printf 'disk3s1\\n'; }
sudo() {
  printf '%s\\n' "$*"
  if [[ "$1" == tee ]]; then cat >/dev/null; fi
  if [[ "$1" == "\${FAIL_COMMAND:-}" ]]; then return 42; fi
  if [[ "$1" == mdutil ]]; then return "$SPOTLIGHT_STATUS"; fi
}
create_darwin_store
`;

const darwinTrace = [
	'tee -a /etc/synthetic.conf',
	'/System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -B',
	'diskutil apfs addVolume disk3 APFS nix -mountpoint /nix',
	'mdutil -i off /nix',
	'chown runner /nix'
];

describe('in-tree Nix installer', () => {
	it.each([0, 1, 77])('continues after Spotlight exits %i', (status) => {
		expect(
			run(darwinCommands, { USER: 'runner', SPOTLIGHT_STATUS: String(status) })
		).toStrictEqual({
			status: 0,
			stdout: `${darwinTrace.filter((line) => !line.includes('apfs.util')).join('\n')}\n`,
			stderr:
				status === 0
					? ''
					: '::warning::Could not disable Spotlight indexing for /nix; continuing Nix installation\n'
		});
	});

	it.each([
		{ command: 'diskutil', last: 2 },
		{ command: 'chown', last: 4 }
	])('fails when $command fails', ({ command, last }) => {
		expect(
			run(darwinCommands, {
				USER: 'runner',
				SPOTLIGHT_STATUS: '0',
				FAIL_COMMAND: command
			})
		).toStrictEqual({
			status: 42,
			stdout: `${darwinTrace
				.slice(0, last + 1)
				.filter((line) => !line.includes('apfs.util'))
				.join('\n')}\n`,
			stderr: ''
		});
	});

	it.each([
		{ architecture: 'x86_64', kernel: 'Linux', system: 'x86_64-linux' },
		{ architecture: 'aarch64', kernel: 'Linux', system: 'aarch64-linux' },
		{ architecture: 'x86_64', kernel: 'Darwin', system: 'x86_64-darwin' },
		{ architecture: 'arm64', kernel: 'Darwin', system: 'aarch64-darwin' }
	])('selects the archive for $system', ({ architecture, kernel, system }) => {
		expect(
			run('nix_system "$ARCHITECTURE" "$KERNEL"', {
				ARCHITECTURE: architecture,
				KERNEL: kernel
			})
		).toStrictEqual({ status: 0, stdout: `${system}\n`, stderr: '' });
	});

	it('rejects unsupported systems before installing', () => {
		expect(run('nix_system riscv64 Linux')).toStrictEqual({
			status: 1,
			stdout: '',
			stderr: '::error::Unsupported runner system: riscv64-Linux\n'
		});
	});

	it.each([
		{ failures: 0, attempts: 1, status: 0 },
		{ failures: 2, attempts: 3, status: 0 },
		{ failures: 3, attempts: 3, status: 1 }
	])(
		'bounds database registration after $failures failures',
		async ({ failures, attempts, status }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-install-nix-')
			);
			onTestFinished(() => rm(directory, { recursive: true, force: true }));
			await mkdir(path.join(directory, 'bin'));
			await writeFile(
				path.join(directory, 'registration'),
				'fixture registration\n'
			);
			await writeFile(
				path.join(directory, 'bin', 'nix-store'),
				String.raw`#!/usr/bin/env bash
set -eu
cat >/dev/null
printf 'attempt\n' >> "$FIXTURE/attempts"
printf 'load %s\n' "$*"
count=$(wc -l < "$FIXTURE/attempts")
[[ "$count" -gt "$FAILURES" ]]
`,
				{ mode: 0o700 }
			);

			expect(
				run(
					'sleep() { :; }; load_nix_database "$FIXTURE" "$FIXTURE/registration"',
					{ FIXTURE: directory, FAILURES: String(failures) }
				)
			).toStrictEqual({
				status,
				stdout: 'load --load-db\n'.repeat(attempts),
				stderr:
					'Retrying Nix database registration\n'.repeat(attempts - 1) +
					(status === 0
						? ''
						: '::error::Nix database registration failed after three attempts\n')
			});
		}
	);
});
