import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
darwin_root_device() { printf 'disk3s1\\n'; }
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
	it('uses the absolute BSD stat path for root-device lookup', () => {
		expect(
			run(String.raw`
stat() { return 42; }
/usr/bin/stat() { printf '%s\n' "$*"; }
darwin_root_device
`)
		).toStrictEqual({ status: 0, stdout: '-f %Sd /\n', stderr: '' });
	});

	it.each([
		{ system: 'x86_64-linux', failure: '', commands: 3 },
		{ system: 'aarch64-linux', failure: '', commands: 3 },
		{ system: 'aarch64-darwin', failure: '', commands: 0 },
		{ system: 'x86_64-linux', failure: 'tee', commands: 1 },
		{ system: 'x86_64-linux', failure: 'udevadm control', commands: 2 },
		{ system: 'x86_64-linux', failure: 'udevadm trigger', commands: 3 }
	])(
		'enables KVM on $system with failure "$failure"',
		async ({ system, failure, commands }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-kvm-'));
			onTestFinished(() => rm(directory, { recursive: true, force: true }));
			const trace = path.join(directory, 'commands');
			const rule = path.join(directory, 'rule');
			await writeFile(trace, '');
			await writeFile(rule, '');
			const result = run(
				String.raw`
sudo() {
  printf '%s\n' "$*" >> "$FIXTURE/commands"
  if [[ "$1" == tee ]]; then cat >> "$FIXTURE/rule"; fi
  [[ -z "$FAIL_COMMAND" || "$*" != "$FAIL_COMMAND"* ]]
}
enable_kvm "$SYSTEM"
`,
				{ FIXTURE: directory, SYSTEM: system, FAIL_COMMAND: failure }
			);
			expect({
				...result,
				commands: await readFile(trace, 'utf8'),
				rule: await readFile(rule, 'utf8')
			}).toStrictEqual({
				status: 0,
				stdout: '',
				stderr:
					failure === ''
						? ''
						: '::warning::Could not enable KVM; continuing Nix installation\n',
				commands: [
					'tee /etc/udev/rules.d/99-install-nix-action-kvm.rules',
					'udevadm control --reload-rules',
					'udevadm trigger --name-match=kvm'
				]
					.slice(0, commands)
					.map((command) => `${command}\n`)
					.join(''),
				rule:
					commands === 0
						? ''
						: 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\n'
			});
		}
	);

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
