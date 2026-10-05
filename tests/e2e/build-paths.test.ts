import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildReceiptV3Schema } from '@cupboard/protocol/build';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { renderActionBundle } from '../../scripts/action-bundles.ts';
import {
	type NixSshStoreFixture,
	startNixSshStore
} from '../support/remote-nix-store.ts';

type StoreKind = 'daemon' | 'daemonless';

interface ActionRun {
	readonly environment: readonly string[];
	readonly rootsDirectory: string;
	readonly requested: readonly string[];
	readonly intermediates: readonly string[];
	readonly built: readonly string[];
	readonly receipt: z.infer<typeof buildReceiptV3Schema>;
	readonly retryClock: readonly { delayMs: number; afterMs: number }[];
}

const fixture: {
	store?: NixSshStoreFixture;
	node?: string;
} = {};
const bundlesDirectory = path.resolve('actions/build-paths/dist');
const rootStateKey = 'cupboard-job-roots';
const pathsSchema = z.array(z.string());
const retryClockSchema = z.array(
	z.object({ delayMs: z.number(), afterMs: z.number() })
);
const nixpkgsLockSchema = z.object({
	locked: z.object({ rev: z.string() })
});
const flakeLockSchema = z.object({ nodes: z.record(z.string(), z.unknown()) });
const dependencySchema = z.object({
	dependencyOut: z.string(),
	dependencyDev: z.string(),
	target: z.string(),
	derivation: z.string()
});
type DependencyPaths = z.infer<typeof dependencySchema>;

function store(): NixSshStoreFixture {
	if (fixture.store === undefined) {
		throw new Error('The Nix container was not prepared');
	}

	return fixture.store;
}

function node(): string {
	if (fixture.node === undefined) {
		throw new Error('The container Node runtime was not prepared');
	}

	return fixture.node;
}

function storeEnvironment(kind: StoreKind): readonly string[] {
	const workspace = `/var/lib/build-paths-${kind}`;

	return [
		`HOME=${workspace}/home`,
		'NIX_USER_CONF_FILES=/dev/null',
		'NIX_CONFIG=experimental-features = nix-command flakes\nsubstituters =\nbuilders =\nsandbox = false',
		...(kind === 'daemon'
			? ['NIX_REMOTE=daemon']
			: [
					'NIX_REMOTE=local',
					`NIX_STORE_DIR=${workspace}/store`,
					`NIX_STATE_DIR=${workspace}/state`,
					`NIX_LOG_DIR=${workspace}/log`
				])
	];
}

function nix(
	kind: StoreKind,
	command: string,
	arguments_: readonly string[]
): Promise<string> {
	return store().exec([
		'env',
		...storeEnvironment(kind),
		command,
		...arguments_
	]);
}

beforeAll(async () => {
	await readFile(path.join(bundlesDirectory, 'main.cjs'));
	await readFile(path.join(bundlesDirectory, 'post.cjs'));
	fixture.store = await startNixSshStore();
	await store().copyDirectory(bundlesDirectory, '/tmp/action/dist');
	await store().copyDirectory(bundlesDirectory, '/tmp/clock-action/dist');
	await store().writeFile(
		'/tmp/clock-action/dist/worker.cjs',
		await renderActionBundle(
			path.resolve('tests/support/build-paths-clock-worker.ts')
		)
	);
	const lock: unknown = JSON.parse(await readFile('flake.lock', 'utf8'));
	const revision = nixpkgsLockSchema.parse(
		flakeLockSchema.parse(lock).nodes.nixpkgs
	).locked.rev;
	const packages = `github:NixOS/nixpkgs/${revision}`;
	const runtime = await store().exec([
		'nix',
		'build',
		'--print-out-paths',
		'--out-link',
		'/tmp/node-runtime',
		`${packages}#nodejs_24^out`
	]);
	fixture.node = `${runtime.trim()}/bin/node`;
	const compiler = await store().exec([
		'nix',
		'build',
		'--print-out-paths',
		'--out-link',
		'/tmp/cc-runtime',
		`${packages}#stdenv.cc^out`
	]);
	await store().writeFile(
		'/tmp/cupboard-hook-relay.c',
		await readFile('packages/cli/hook-helper/cupboard-hook-relay.c', 'utf8')
	);
	await store().exec([
		`${compiler.trim()}/bin/cc`,
		'-O2',
		'-o',
		'/tmp/cupboard-hook-relay',
		'/tmp/cupboard-hook-relay.c'
	]);
	await store().exec([
		'sh',
		'-c',
		'nix-daemon </dev/null >/tmp/build-paths-daemon.log 2>&1 &'
	]);
	await vi.waitFor(
		async () => {
			const readiness = await store().exec([
				'sh',
				'-c',
				'test -S /nix/var/nix/daemon-socket/socket && echo ready || echo pending'
			]);

			expect(readiness).toBe('ready');
		},
		{ timeout: 10_000 }
	);
	for (const kind of ['daemon', 'daemonless'] as const) {
		await store().exec([
			'mkdir',
			'-p',
			`/var/lib/build-paths-${kind}/home`,
			`/tmp/build-paths-${kind}/runner`,
			`/var/lib/build-paths-${kind}/store`,
			`/var/lib/build-paths-${kind}/state`,
			`/var/lib/build-paths-${kind}/log`
		]);
	}
}, 240_000);

afterAll(async () => {
	await fixture.store?.close();
});

async function instantiate(
	kind: StoreKind,
	isFailing: boolean
): Promise<DependencyPaths> {
	const seed = randomUUID().replaceAll('-', '');
	const expressionFile = `/tmp/fixture-${seed}.nix`;
	const systemOutput = await nix(kind, 'nix', [
		'eval',
		'--impure',
		'--raw',
		'--expr',
		'builtins.currentSystem'
	]);
	const system = systemOutput.trim();
	await store().writeFile(
		expressionFile,
		`let
			dependency = builtins.derivation {
				name = "build-paths-dependency-${seed}";
				system = "${system}";
				builder = "/bin/sh";
				outputs = [ "out" "dev" ];
				args = [ "-c" "echo out > $out; echo dev > $dev" ];
			};
			target = builtins.derivation {
				name = "build-paths-target-${seed}";
				system = "${system}";
				builder = "/bin/sh";
				args = [ "-c" "cat \${dependency.out} \${dependency.dev} > /dev/null; ${isFailing ? 'exit 1' : 'echo target > $out'}" ];
			};
		in { inherit dependency target; }`
	);
	await nix(kind, 'nix-instantiate', [expressionFile, '--attr', 'target']);
	const encoded = await nix(kind, 'nix-instantiate', [
		'--eval',
		'--strict',
		'--json',
		'--expr',
		`let fixture = import ${expressionFile}; in {
			dependencyOut = fixture.dependency.out.outPath;
			dependencyDev = fixture.dependency.dev.outPath;
			target = fixture.target.outPath;
			derivation = fixture.target.drvPath;
		}`
	]);
	const parsed: unknown = JSON.parse(encoded);

	return dependencySchema.parse(parsed);
}

async function runAction(
	kind: StoreKind,
	derivation: string,
	isAllowFailure = false
): Promise<ActionRun> {
	const directory = `/tmp/build-paths-${kind}/runner/${randomUUID()}`;
	await store().exec(['mkdir', '-p', directory]);
	const environment = [
		...storeEnvironment(kind),
		`RUNNER_TEMP=${directory}`,
		`GITHUB_OUTPUT=${directory}/outputs`,
		`GITHUB_STATE=${directory}/state`,
		'INPUT_PUBLISH=built',
		'INPUT_SUBSTITUTER=copy',
		'INPUT_INLINE-PATHS=false',
		'INPUT_INSTALLABLES-FILE=',
		'INPUT_KEEP-GOING=false',
		'INPUT_MAX-JOBS=',
		'INPUT_BUILD=',
		'INPUT_REQUIRE-PROVENANCE=',
		'INPUT_PUBLICATION-URL=',
		'INPUT_READ-SESSION-TARGET=',
		'INPUT_READ-SESSION-CACHES=',
		'INPUT_READ-SESSION-VIEW=',
		'INPUT_AUDIENCE=',
		`INPUT_INSTALLABLES=${derivation}^*`,
		'INPUT_CUPBOARD-PATH=/tmp/cupboard',
		`INPUT_ALLOW-FAILURE=${String(isAllowFailure)}`
	];
	await store().exec([
		'timeout',
		'--signal=TERM',
		'--kill-after=10s',
		'180s',
		'env',
		...environment,
		node(),
		isAllowFailure
			? '/tmp/clock-action/dist/main.cjs'
			: '/tmp/action/dist/main.cjs'
	]);
	const outputFile = await store().exec(['cat', `${directory}/outputs`]);
	const outputs = Object.fromEntries(
		outputFile
			.trim()
			.split('\n')
			.map((line) => {
				const separator = line.indexOf('=');

				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
	const readPaths = async (output: string): Promise<readonly string[]> => {
		const file = z.string().parse(outputs[output]);

		const contents = await store().exec(['cat', file]);

		return pathsSchema.parse(contents.split('\n').filter(Boolean));
	};
	const state = await store().exec(['cat', `${directory}/state`]);
	const rootEntry = state
		.split('\n')
		.find((line) => line.startsWith(`${rootStateKey}=`));
	const rootsDirectory = z
		.string()
		.parse(rootEntry?.slice(rootStateKey.length + 1));
	const encoded = await store().exec([
		'cat',
		z.string().parse(outputs['receipt-file'])
	]);
	const receipt: unknown = JSON.parse(encoded);
	const builtEncoded = await store().exec([
		'cat',
		z.string().parse(outputs['built-receipt-file'])
	]);
	const builtReceipt: unknown = JSON.parse(builtEncoded);
	const retryClockText = isAllowFailure
		? await store().exec(['cat', `${directory}/retry-clock.jsonl`])
		: undefined;
	const retryClock: unknown =
		retryClockText
			?.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line)) ?? [];

	return {
		environment,
		rootsDirectory,
		requested: await readPaths('publish-paths-file'),
		intermediates: await readPaths('intermediate-paths-file'),
		built: buildReceiptV3Schema.parse(builtReceipt).paths,
		receipt: buildReceiptV3Schema.parse(receipt),
		retryClock: retryClockSchema.parse(retryClock)
	};
}

async function cleanup(action: ActionRun): Promise<void> {
	await store().exec([
		'env',
		...action.environment,
		`STATE_${rootStateKey}=${action.rootsDirectory}`,
		node(),
		'/tmp/action/dist/post.cjs'
	]);
}

async function invalidPaths(
	kind: StoreKind,
	paths: readonly string[]
): Promise<readonly string[]> {
	const invalid = await nix(kind, 'nix-store', [
		'--check-validity',
		'--print-invalid',
		...paths
	]);

	return invalid.split('\n').filter(Boolean);
}

async function exportPaths(
	kind: StoreKind,
	paths: readonly string[]
): Promise<void> {
	await nix(kind, 'sh', [
		'-c',
		'nix-store --export "$@" >/tmp/build-paths-export.nar',
		'sh',
		...paths
	]);
}

function sorted(paths: readonly string[]): readonly string[] {
	return paths.toSorted((left, right) => left.localeCompare(right));
}

describe('native build-paths action with real Nix', () => {
	it.each(['daemon', 'daemonless'] as const)(
		'keeps build-only intermediates through GC and cleans invocation roots with %s',
		async (kind) => {
			const paths = await instantiate(kind, false);
			const intermediates = sorted([paths.dependencyOut, paths.dependencyDev]);
			const cold = await runAction(kind, paths.derivation);
			await nix(kind, 'nix-store', ['--gc']);
			await exportPaths(kind, [...cold.requested, ...cold.intermediates]);
			const coldInvalid = await invalidPaths(kind, [
				paths.target,
				...intermediates
			]);
			const closureOutput = await nix(kind, 'nix-store', [
				'--query',
				'--requisites',
				paths.target
			]);
			const closure = closureOutput.trim().split('\n');
			const warm = await runAction(kind, paths.derivation);

			expect({
				cold: {
					requested: cold.requested,
					intermediates: sorted(cold.intermediates),
					built: cold.built,
					receiptPaths: sorted(cold.receipt.paths),
					origins: cold.receipt.subjects.map((subject) => subject.origin),
					invalid: coldInvalid,
					closure
				},
				warm: {
					requested: warm.requested,
					intermediates: warm.intermediates,
					built: warm.built,
					receiptPaths: warm.receipt.paths,
					origins: warm.receipt.subjects.map((subject) => subject.origin)
				}
			}).toStrictEqual({
				cold: {
					requested: [paths.target],
					intermediates,
					built: [paths.target],
					receiptPaths: sorted([paths.target, ...intermediates]),
					origins: ['built', 'built', 'built'],
					invalid: [],
					closure: [paths.target]
				},
				warm: {
					requested: [paths.target],
					intermediates: [],
					built: [],
					receiptPaths: [paths.target],
					origins: ['store-held']
				}
			});

			await cleanup(cold);
			await cleanup(cold);
			await nix(kind, 'nix-store', ['--gc']);
			const afterCold = await invalidPaths(kind, [
				paths.target,
				...intermediates
			]);
			await cleanup(warm);
			await nix(kind, 'nix-store', ['--gc']);
			const afterWarm = await invalidPaths(kind, [
				paths.target,
				...intermediates
			]);

			expect({
				afterCold: sorted(afterCold),
				afterWarm: sorted(afterWarm)
			}).toStrictEqual({
				afterCold: intermediates,
				afterWarm: sorted([paths.target, ...intermediates])
			});
		},
		240_000
	);

	it.each(['daemon', 'daemonless'] as const)(
		'selects completed dependencies when the target fails with %s',
		async (kind) => {
			const paths = await instantiate(kind, true);
			const intermediates = sorted([paths.dependencyOut, paths.dependencyDev]);
			const action = await runAction(kind, paths.derivation, true);
			await nix(kind, 'nix-store', ['--gc']);
			await exportPaths(kind, action.intermediates);

			expect({
				retryClock: action.retryClock,
				requested: action.requested,
				intermediates: sorted(action.intermediates),
				built: action.built,
				receiptPaths: sorted(action.receipt.paths),
				origins: action.receipt.subjects.map((subject) => subject.origin),
				invalid: await invalidPaths(kind, intermediates)
			}).toStrictEqual({
				retryClock: [
					{ delayMs: 15_000, afterMs: 15_000 },
					{ delayMs: 30_000, afterMs: 45_000 },
					{ delayMs: 45_000, afterMs: 90_000 },
					{ delayMs: 60_000, afterMs: 150_000 }
				],
				requested: [],
				intermediates,
				built: [],
				receiptPaths: intermediates,
				origins: ['built', 'built'],
				invalid: []
			});

			await cleanup(action);
			await nix(kind, 'nix-store', ['--gc']);
			expect(sorted(await invalidPaths(kind, intermediates))).toStrictEqual(
				intermediates
			);
		},
		240_000
	);
});
