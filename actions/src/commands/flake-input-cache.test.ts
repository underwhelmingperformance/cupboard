import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NixValidPathInfo, PublicObjectAccess } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import type { NixCopyOptions } from '../nix-copy.ts';
import { recordingGithubReporter } from '../reporter-testing.ts';

import {
	flakeInputCacheAction,
	type FlakeInputCacheDependencies
} from './flake-input-cache.ts';

// The source path of `narHash` with the default name, from
// `nix store add --mode nar` with Nix 2.35.3.
const narHash = 'sha256-m/i4zIJHKRtapNnPwNUoFromRkwfucNCdbqZ1oxSjWo=';
const sourcePath = storePathSchema.parse(
	'/nix/store/bgb79jccl8x3lxrwr6skmhb2sz10qizp-source'
);
const rev = '0123456789abcdef0123456789abcdef01234567';

const nixpkgs = {
	locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev, narHash },
	original: {}
};

function lockWith(nodes: Readonly<Record<string, unknown>>): string {
	return JSON.stringify({ version: 7, root: 'root', nodes });
}

const lock = lockWith({ root: { inputs: { nixpkgs: 'nixpkgs' } }, nixpkgs });

function pathInfo(): NixValidPathInfo {
	return {
		storePath: sourcePath,
		narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
		narSize: 1,
		references: [],
		signatures: [],
		ultimate: false
	};
}

class NixCopyFailedError extends Error {
	constructor() {
		super('nix copy failed');
		this.name = 'NixCopyFailedError';
	}
}

interface Scenario {
	readonly lockText?: string;
	readonly copyFails?: boolean;
	readonly signal?: AbortSignal;
	readonly dependencies: Pick<
		FlakeInputCacheDependencies,
		'probeOrigin' | 'fetch' | 'originDeadline'
	>;
}

const answering =
	(access: PublicObjectAccess) => (): Promise<PublicObjectAccess> =>
		Promise.resolve(access);

function copyTo(cache: string): NixCopyOptions[] {
	return [
		{
			paths: [sourcePath],
			to: `file://${cache}?compression=none`,
			quiet: true
		}
	];
}

class RequestAbortedError extends Error {
	constructor(cause: unknown) {
		super('the origin request was aborted', { cause });
		this.name = 'RequestAbortedError';
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new RequestAbortedError(signal.reason);
}

// A request that waits for its signal, so that only an abort ends it.
const waitingFetch: NonNullable<FlakeInputCacheDependencies['fetch']> = (
	_input,
	init
) =>
	new Promise((_resolve, reject) => {
		const signal = init?.signal;

		if (signal === undefined || signal === null) {
			return;
		}

		if (signal.aborted) {
			reject(abortReason(signal));
			return;
		}

		signal.addEventListener('abort', () => {
			reject(abortReason(signal));
		});
	});

const stepSchema = z.looseObject({ name: z.string().optional() });
const stepsSchema = z.array(stepSchema);
const prepareStepsSchema = z.object({ runs: z.object({ steps: stepsSchema }) });

function cachePath(
	contents: string,
	step: 'restore' | 'save'
): string | undefined {
	return new RegExp(
		String.raw`uses: actions/cache/${step}@\S+ # v[\d.]+\n\s+with:\n\s+path: (?<path>\S+)\n`,
		'u'
	).exec(contents)?.groups?.path;
}

// actions/cache identifies an entry by the path as written, so the restore in
// actions/prepare and the save in actions/plan must use the same string, and
// the directory that the command fills must be that path.
describe('flake input cache steps', () => {
	it('restore and save the directory that the command fills', async () => {
		const [prepare, script, plan] = await Promise.all([
			readFile(new URL('../../prepare/action.yml', import.meta.url), 'utf8'),
			readFile(
				new URL('../../prepare/flake-input-cache.sh', import.meta.url),
				'utf8'
			),
			readFile(new URL('../../plan/action.yml', import.meta.url), 'utf8')
		]);

		expect({
			restore: cachePath(prepare, 'restore'),
			save: cachePath(plan, 'save'),
			directory: /^directory="(?<directory>[^"]+)"$/mu.exec(script)?.groups
				?.directory
		}).toStrictEqual({
			restore: '~/.cache/cupboard-flake-inputs',
			save: '~/.cache/cupboard-flake-inputs',
			directory: '${HOME}/.cache/cupboard-flake-inputs'
		});
	});

	// With store set, only the evaluation of nix-config reads the restored
	// cache, so without nix-config the restore downloads nothing. The plan job
	// still needs cache-hit, which records the restore.
	it('restore the cache only for a step that reads it', async () => {
		const source = await readFile(
			new URL('../../prepare/action.yml', import.meta.url),
			'utf8'
		);
		const prepare = prepareStepsSchema.parse(parse(source));
		const steps = prepare.runs.steps.filter(
			(step) =>
				step.name === 'Restore the flake input cache' ||
				step.name === 'Record the restored flake input cache'
		);

		expect(steps).toStrictEqual([
			{
				name: 'Restore the flake input cache',
				id: 'restore-flake-inputs',
				if: "${{ steps.flake-input-cache.outputs.key != '' }}",
				'continue-on-error': true,
				uses: 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
				with: {
					path: '~/.cache/cupboard-flake-inputs',
					key: '${{ steps.flake-input-cache.outputs.key }}',
					'lookup-only': "${{ inputs.store != '' && inputs.nix-config == '' }}"
				}
			},
			{
				name: 'Record the restored flake input cache',
				if: "${{ steps.restore-flake-inputs.outputs.cache-hit == 'true' }}",
				shell: 'bash',
				run: 'bash "${GITHUB_ACTION_PATH}/flake-input-cache.sh" restored\n'
			}
		]);
	});
});

// The plan job builds nothing, so it collects and saves whenever the restore
// found no entry, whatever builders or store the job has.
describe('flake input cache collection', () => {
	it('depends only on the key and the restore', async () => {
		const plan = await readFile(
			new URL('../../plan/action.yml', import.meta.url),
			'utf8'
		);
		const condition =
			/- name: Collect public flake input sources\n\s+id: flake-inputs\n\s+if: >-\n(?<condition>(?:\s{8}.+\n)+)/u
				.exec(plan)
				?.groups?.condition?.replaceAll(/\s+/gu, ' ')
				.trim();

		expect(condition).toBe(
			"${{ env.CUPBOARD_FLAKE_INPUT_CACHE_KEY != '' && env.CUPBOARD_FLAKE_INPUT_CACHE_RESTORED != 'true' }}"
		);
	});
});

describe('flakeInputCacheAction', () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-flake-inputs-'));
	});

	afterEach(async () => {
		await rm(directory, { force: true, recursive: true });
	});

	async function run(scenario: Scenario) {
		const flakeLock = path.join(directory, 'flake.lock');
		const output = path.join(directory, 'github-output');
		const cache = path.join(directory, 'cache');
		const copies: NixCopyOptions[] = [];
		const recording = recordingGithubReporter();

		await writeFile(output, '');

		if (scenario.lockText !== undefined) {
			await writeFile(flakeLock, scenario.lockText);
		}

		await flakeInputCacheAction(
			{ directory: cache, flakeLock },
			{ GITHUB_OUTPUT: output },
			scenario.signal,
			{
				reporter: recording.reporter,
				nix: {
					storeDirectory: storeDirectorySchema.parse('/nix/store'),
					queryValidPathsInfo: () => Promise.resolve([pathInfo()])
				},
				...scenario.dependencies,
				copy: (options) => {
					copies.push(options);

					return scenario.copyFails === true
						? Promise.reject(new NixCopyFailedError())
						: Promise.resolve();
				}
			}
		);
		const lines = recording.log().split('\n');

		return {
			copies,
			output: await readFile(output, 'utf8'),
			warnings: lines.filter((line) => line.startsWith('::warning::')).length,
			hostNotes: lines.filter((line) => line.startsWith('Left out')),
			cache
		};
	}

	it('copies the public sources to the cache directory', async () => {
		const result = await run({
			lockText: lock,
			dependencies: { probeOrigin: answering('public') }
		});

		expect(result).toStrictEqual({
			copies: copyTo(result.cache),
			output: 'save=true\n',
			warnings: 0,
			hostNotes: [],
			cache: result.cache
		});
	});

	it.each<{ name: string; scenario: Scenario; warnings: number }>([
		{
			name: 'no public sources',
			scenario: {
				lockText: lock,
				dependencies: { probeOrigin: answering('private') }
			},
			warnings: 0
		},
		{
			name: 'an origin without a definite answer',
			scenario: {
				lockText: lock,
				dependencies: { probeOrigin: answering('unavailable') }
			},
			warnings: 1
		},
		{
			name: 'no flake.lock',
			scenario: { dependencies: { probeOrigin: answering('public') } },
			warnings: 0
		},
		{
			name: 'a flake.lock that does not parse',
			scenario: {
				lockText: '{',
				dependencies: { probeOrigin: answering('public') }
			},
			warnings: 1
		}
	])('saves nothing for $name', async ({ scenario, warnings }) => {
		const result = await run(scenario);

		expect(result).toStrictEqual({
			copies: [],
			output: 'save=false\n',
			warnings,
			hostNotes: [],
			cache: result.cache
		});
	});

	it('warns about a malformed entry and saves the other sources', async () => {
		const result = await run({
			lockText: lockWith({
				root: { inputs: { broken: 'broken', nixpkgs: 'nixpkgs' } },
				broken: { locked: { type: 7 } },
				nixpkgs
			}),
			dependencies: { probeOrigin: answering('public') }
		});

		expect(result).toStrictEqual({
			copies: copyTo(result.cache),
			output: 'save=true\n',
			warnings: 1,
			hostNotes: [],
			cache: result.cache
		});
	});

	it.each([
		{
			name: 'a URL with a token',
			url: 'https://ci:hunter2@git.example.com/acme/secret.tar.gz?token=abc#top',
			warning:
				'::warning::Leaving a flake input out of the cache: secret (https://git.example.com/acme/secret.tar.gz), which is not a cache candidate, locks the same source path as nixpkgs'
		},
		{
			name: 'a URL that does not parse',
			url: 'git@github.com:acme/secret.git',
			warning:
				'::warning::Leaving a flake input out of the cache: secret, which is not a cache candidate, locks the same source path as nixpkgs'
		}
	])(
		'identifies the entry that shares a source path, with $name',
		async ({ url, warning }) => {
			const recording = recordingGithubReporter();
			const flakeLock = path.join(directory, 'flake.lock');
			await writeFile(
				flakeLock,
				lockWith({
					root: { inputs: { secret: 'secret', nixpkgs: 'nixpkgs' } },
					secret: { locked: { type: 'tarball', url, narHash } },
					nixpkgs
				})
			);

			await flakeInputCacheAction(
				{ directory: path.join(directory, 'cache'), flakeLock },
				{},
				undefined,
				{
					reporter: recording.reporter,
					nix: {
						storeDirectory: storeDirectorySchema.parse('/nix/store'),
						queryValidPathsInfo: () => Promise.resolve([pathInfo()])
					},
					probeOrigin: answering('public'),
					copy: () => Promise.resolve()
				}
			);

			expect(
				recording
					.log()
					.split('\n')
					.filter((line) => line.startsWith('::warning::'))
			).toStrictEqual([warning]);
		}
	);

	it('notes once which inputs are on other hosts', async () => {
		const result = await run({
			lockText: lockWith({
				root: { inputs: { a: 'a', b: 'b', nixpkgs: 'nixpkgs' } },
				a: {
					locked: {
						type: 'tarball',
						url: 'https://example.com/a.tar.gz',
						narHash: `sha256-${'A'.repeat(43)}=`
					}
				},
				b: {
					locked: {
						...nixpkgs.locked,
						host: 'git.example.com',
						narHash: `sha256-${'B'.repeat(42)}A=`
					}
				},
				nixpkgs
			}),
			dependencies: { probeOrigin: answering('public') }
		});

		expect(result).toStrictEqual({
			copies: copyTo(result.cache),
			output: 'save=true\n',
			warnings: 0,
			hostNotes: [
				'Left out 2 flake inputs whose origin is not an HTTPS github.com URL without a query string, because the runner cannot prove that such an origin is public: a, b'
			],
			cache: result.cache
		});
	});

	it('warns and saves nothing when the copy fails', async () => {
		const result = await run({
			lockText: lock,
			copyFails: true,
			dependencies: { probeOrigin: answering('public') }
		});

		expect(result).toStrictEqual({
			copies: copyTo(result.cache),
			output: 'save=false\n',
			warnings: 1,
			hostNotes: [],
			cache: result.cache
		});
	});

	it('treats an expired origin deadline as no definite answer', async () => {
		const result = await run({
			lockText: lock,
			dependencies: {
				fetch: waitingFetch,
				originDeadline: () => AbortSignal.abort(new Error('deadline'))
			}
		});

		expect(result).toStrictEqual({
			copies: [],
			output: 'save=false\n',
			warnings: 1,
			hostNotes: [],
			cache: result.cache
		});
	});

	it('stops when the job is cancelled during an origin request', async () => {
		const controller = new AbortController();
		const reason = new Error('job cancelled');
		const fetch: NonNullable<FlakeInputCacheDependencies['fetch']> = (
			input,
			init
		) => {
			const response = waitingFetch(input, init);
			controller.abort(reason);

			return response;
		};

		await expect(
			run({
				lockText: lock,
				signal: controller.signal,
				dependencies: {
					fetch,
					originDeadline: () => new AbortController().signal
				}
			})
		).rejects.toBe(reason);
		await expect(
			readFile(path.join(directory, 'github-output'), 'utf8')
		).resolves.toBe('');
	});
});
