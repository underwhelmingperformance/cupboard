import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';

const installer = fileURLToPath(
	new URL('../install-nix/install.sh', import.meta.url)
);
const versionsFile = new URL('../install-nix/versions.env', import.meta.url);
const systemsFile = new URL(
	'../../packages/nix/src/nix-systems.json',
	import.meta.url
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

async function readLines(file: string): Promise<string[]> {
	if (!existsSync(file)) {
		return [];
	}

	const contents = await readFile(file, 'utf8');

	return contents.split('\n').filter(Boolean);
}

async function readPrivateFile(
	file: string
): Promise<{ contents: string; mode: number } | undefined> {
	if (!existsSync(file)) {
		return undefined;
	}

	const { mode } = await stat(file);

	return { contents: await readFile(file, 'utf8'), mode: mode & 0o777 };
}

async function readSortedDirectory(directory: string): Promise<string[]> {
	const entries = await readdir(directory);

	return entries.toSorted((left, right) => left.localeCompare(right));
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

	it('pins an archive digest for every supported system', async () => {
		const systems = z
			.array(z.object({ system: z.string() }))
			.parse(JSON.parse(await readFile(systemsFile, 'utf8')));
		const versions = await readFile(versionsFile, 'utf8');
		const pinned = Object.fromEntries(
			versions
				.matchAll(/^sha256_(?<system>\w+)=(?<digest>.*)$/gmu)
				.map(({ groups }): [string, boolean] => [
					groups?.system ?? '',
					/^[0-9a-f]{64}$/u.test(groups?.digest ?? '')
				])
		);

		expect(pinned).toStrictEqual(
			Object.fromEntries(
				systems.map(({ system }) => [system.replaceAll('-', '_'), true])
			)
		);
	});

	const archive = 'fixture archive\n';
	const archiveDigest = createHash('sha256').update(archive).digest('hex');
	const otherDigest = createHash('sha256').update('other\n').digest('hex');
	const download =
		'download https://github.com/nixbuild/nix-quick-install-action/releases/download/v0/nix-2.0.0-x86_64-linux.tar.zstd';
	const malformedPin =
		'::error::versions.env does not set sha256_x86_64_linux to a lowercase hexadecimal SHA-256 digest for nix-2.0.0-x86_64-linux.tar.zstd.\n';

	it.each([
		{
			name: 'a matching digest',
			pinned: archiveDigest,
			tarStatus: 0,
			status: 0,
			stderr: '',
			trace: [download, 'prepare x86_64-linux', 'extract'],
			extracted: archive
		},
		{
			name: 'a matching digest and a failing tar',
			pinned: archiveDigest,
			tarStatus: 2,
			status: 2,
			stderr: '',
			trace: [download, 'prepare x86_64-linux', 'extract'],
			extracted: undefined
		},
		{
			name: 'a different digest',
			pinned: otherDigest,
			tarStatus: 0,
			status: 1,
			stderr: `::error::nix-2.0.0-x86_64-linux.tar.zstd has SHA-256 digest ${archiveDigest}, but versions.env expects ${otherDigest}. If nix_version and archive_release have not changed, the upstream release asset has changed: investigate it and do not update the pin. actions/install-nix/README.md describes how to record the digests for a new version.\n`,
			trace: [download],
			extracted: undefined
		},
		{
			name: 'no digest',
			pinned: '',
			tarStatus: 0,
			status: 1,
			stderr: malformedPin,
			trace: [],
			extracted: undefined
		},
		{
			name: 'a prefixed digest',
			pinned: `sha256:${archiveDigest}`,
			tarStatus: 0,
			status: 1,
			stderr: malformedPin,
			trace: [],
			extracted: undefined
		}
	])(
		'verifies the archive before it changes the store, with $name',
		async ({ pinned, tarStatus, status, stderr, trace, extracted }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-install-archive-')
			);
			onTestFinished(() => rm(directory, { recursive: true, force: true }));
			const temporary = path.join(directory, 'temporary');
			await mkdir(temporary);
			await writeFile(path.join(directory, 'archive'), archive);
			const result = run(
				String.raw`
nix_version=2.0.0
archive_release=v0
sha256_x86_64_linux=$PINNED
curl() {
  local output=
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) output=$2; shift ;;
      https://*) printf 'download %s\n' "$1" >> "$FIXTURE/trace" ;;
    esac
    shift
  done
  if [[ -n "$output" ]]; then
    cat "$FIXTURE/archive" > "$output"
  else
    cat "$FIXTURE/archive"
  fi
}
prepare_store() {
  printf 'prepare %s\n' "$1" >> "$FIXTURE/trace"
}
fixture_tar() {
  local file=
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == -f ]]; then file=$2; shift; fi
    shift
  done
  printf 'extract\n' >> "$FIXTURE/trace"
  if [[ "$TAR_STATUS" != 0 ]]; then
    return "$TAR_STATUS"
  fi
  if [[ -n "$file" ]]; then
    cat "$file" > "$FIXTURE/extracted"
  else
    cat > "$FIXTURE/extracted"
  fi
}
install_archive x86_64-linux fixture_tar
`,
				{
					FIXTURE: directory,
					PINNED: pinned,
					RUNNER_TEMP: temporary,
					TAR_STATUS: String(tarStatus)
				}
			);
			const extractedFile = path.join(directory, 'extracted');

			expect({
				...result,
				trace: await readLines(path.join(directory, 'trace')),
				extracted: existsSync(extractedFile)
					? await readFile(extractedFile, 'utf8')
					: undefined,
				remaining: await readdir(temporary)
			}).toStrictEqual({
				status,
				stdout: '',
				stderr,
				trace,
				extracted,
				remaining: []
			});
		}
	);

	const settings =
		'\nextra-experimental-features = nix-command flakes\naccept-flake-config = true\n';
	const include = '\n!include github-access-token.conf\n';
	const jobEntry =
		'machine github.com\nlogin github-token\npassword fixture-token\n';
	const otherEntry = 'machine example.com login fixture password other\n';
	const laterEntry = 'machine example.org\nlogin fixture\npassword other\n';
	// The files that two runs of the released installer wrote with umask 022.
	const releasedConfiguration =
		`\naccess-tokens = github.com=released-token\n${settings}`.repeat(2);
	const releasedEntry =
		'machine github.com\nlogin github-token\npassword released-token\n';

	it.each([
		{
			name: 'a new runner',
			token: 'fixture-token',
			initial: undefined,
			files: ['github-access-token.conf', 'nix.conf'],
			nixConf: `${include}${settings}${settings}`,
			tokenFile: 'access-tokens = github.com=fixture-token\n',
			netrc: jobEntry
		},
		{
			name: 'a new runner without a token',
			token: '',
			initial: undefined,
			files: ['nix.conf'],
			nixConf: `${settings}${settings}`,
			tokenFile: undefined,
			netrc: undefined
		},
		{
			name: 'the files of the released installer',
			token: 'fixture-token',
			initial: {
				nixConf: releasedConfiguration,
				netrc: `${otherEntry}${releasedEntry}${releasedEntry}${laterEntry}`
			},
			files: ['github-access-token.conf', 'nix.conf'],
			nixConf: `${`\n${settings}`.repeat(2)}${include}${settings}${settings}`,
			tokenFile: 'access-tokens = github.com=fixture-token\n',
			netrc: `${otherEntry}${laterEntry}${jobEntry}`
		}
	])(
		'keeps the access token in private files, starting from $name',
		async ({ token, initial, files, nixConf, tokenFile, netrc }) => {
			const home = await mkdtemp(path.join(tmpdir(), 'cupboard-nix-config-'));
			onTestFinished(() => rm(home, { recursive: true, force: true }));
			const configuration = path.join(home, '.config', 'nix');

			if (initial !== undefined) {
				await mkdir(configuration, { recursive: true });
				await writeFile(path.join(configuration, 'nix.conf'), initial.nixConf, {
					mode: 0o644
				});
				await writeFile(path.join(home, '.netrc'), initial.netrc, {
					mode: 0o600
				});
			}

			const result = run('configure_nix\nconfigure_nix', {
				HOME: home,
				XDG_CONFIG_HOME: '',
				GITHUB_ACCESS_TOKEN: token
			});
			expect({
				...result,
				home: await readSortedDirectory(home),
				files: await readSortedDirectory(configuration),
				nixConf: await readPrivateFile(path.join(configuration, 'nix.conf')),
				tokenFile: await readPrivateFile(
					path.join(configuration, 'github-access-token.conf')
				),
				netrc: await readPrivateFile(path.join(home, '.netrc'))
			}).toStrictEqual({
				status: 0,
				stdout: '',
				stderr: '',
				home: netrc === undefined ? ['.config'] : ['.config', '.netrc'],
				files,
				nixConf: { contents: nixConf, mode: 0o600 },
				tokenFile:
					tokenFile === undefined
						? undefined
						: { contents: tokenFile, mode: 0o600 },
				netrc:
					netrc === undefined ? undefined : { contents: netrc, mode: 0o600 }
			});
		}
	);
});
