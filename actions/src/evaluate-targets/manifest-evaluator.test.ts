import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
	evaluateTargetManifest,
	type ManifestRunner
} from './manifest-evaluator.ts';

async function resultOrError(operation: Promise<unknown>): Promise<unknown> {
	try {
		return await operation;
	} catch (error) {
		return error;
	}
}

const target = (index: number) => ({
	attr: `.#package${String(index)}`,
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	rootSuffix: `/package${String(index)}/`
});

const options = { targets: '.#targets', publish: 'outputs' };
const execFileAsync = promisify(execFile);
const errorName = (error: unknown): string | undefined =>
	error instanceof Error ? error.name : undefined;

describe('target manifest evaluation', () => {
	it('discovers the count, bounds evaluation and preserves raw manifest order', async () => {
		const pending = Array.from({ length: 6 }, () =>
			Promise.withResolvers<string>()
		);
		const started = pending.map(() => Promise.withResolvers<undefined>());
		const calls: string[][] = [];
		const trace: string[] = [];
		let active = 0;
		let maximumActive = 0;
		const runner: ManifestRunner = async (arguments_) => {
			calls.push([...arguments_]);
			if (arguments_.at(-1) === 'builtins.length') {
				return '6';
			}
			const index = Number(arguments_.at(-1)?.match(/ (\d+)$/u)?.[1]);
			const result = pending[index];
			if (result === undefined) {
				throw new Error('Unexpected target index');
			}
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			trace.push(`start ${String(index)}`);
			started[index]?.resolve(undefined);
			const value = await result.promise;
			active -= 1;
			trace.push(`close ${String(index)}`);
			return value;
		};
		const evaluation = evaluateTargetManifest(options, runner);
		await Promise.all(started.slice(0, 4).map((notice) => notice.promise));
		expect(trace).toStrictEqual(['start 0', 'start 1', 'start 2', 'start 3']);
		pending[2]?.resolve(JSON.stringify(target(2)));
		await started[4]?.promise;
		expect(trace).toStrictEqual([
			'start 0',
			'start 1',
			'start 2',
			'start 3',
			'close 2',
			'start 4'
		]);
		pending[0]?.resolve(JSON.stringify(target(0)));
		await started[5]?.promise;
		expect(trace).toStrictEqual([
			'start 0',
			'start 1',
			'start 2',
			'start 3',
			'close 2',
			'start 4',
			'close 0',
			'start 5'
		]);
		for (const index of [5, 1, 4, 3]) {
			pending[index]?.resolve(JSON.stringify(target(index)));
		}
		const manifest = await evaluation;
		const parsedManifest: unknown = JSON.parse(manifest);
		expect({
			manifest: parsedManifest,
			calls,
			maximumActive,
			active,
			trace
		}).toStrictEqual({
			manifest: Array.from({ length: 6 }, (_, index) => target(index)),
			calls: [
				['eval', '--json', '.#targets', '--apply', 'builtins.length'],
				...[0, 1, 2, 3, 4, 5].map((index) => [
					'eval',
					'--json',
					'.#targets',
					'--apply',
					`targets: builtins.elemAt targets ${String(index)}`
				])
			],
			maximumActive: 4,
			active: 0,
			trace: [
				'start 0',
				'start 1',
				'start 2',
				'start 3',
				'close 2',
				'start 4',
				'close 0',
				'start 5',
				'close 5',
				'close 1',
				'close 4',
				'close 3'
			]
		});
	});

	it.each([
		'false',
		'"6"',
		'-1',
		'0',
		'1.5',
		'9007199254740992',
		'null',
		'{}',
		'not-json'
	])(
		'rejects invalid discovery without scheduling a target: %s',
		async (count) => {
			const calls: string[][] = [];
			const result = await resultOrError(
				evaluateTargetManifest(options, (arguments_) => {
					calls.push([...arguments_]);
					return Promise.resolve(count);
				})
			);
			expect({ name: errorName(result), calls }).toStrictEqual({
				name: 'ManifestCountInvalidError',
				calls: [['eval', '--json', '.#targets', '--apply', 'builtins.length']]
			});
		}
	);

	it('stops when discovery fails and preserves the original error', async () => {
		const failure = new Error('Count refused');
		const calls: string[][] = [];
		const result = await resultOrError(
			evaluateTargetManifest(options, (arguments_) => {
				calls.push([...arguments_]);
				return Promise.reject(failure);
			})
		);
		expect({ result, calls }).toStrictEqual({
			result: failure,
			calls: [['eval', '--json', '.#targets', '--apply', 'builtins.length']]
		});
	});

	it.each([
		{ title: 'invalid target', values: [{ attr: '.#invalid' }] },
		{
			title: 'canonical duplicate roots',
			values: [target(0), { ...target(1), rootSuffix: 'package0' }]
		}
	])('rejects the complete $title manifest', async ({ values }) => {
		let index = 0;
		const runner: ManifestRunner = (arguments_) =>
			Promise.resolve(
				arguments_.at(-1) === 'builtins.length'
					? JSON.stringify(values.length)
					: JSON.stringify(values[index++])
			);
		const result = await resultOrError(evaluateTargetManifest(options, runner));
		expect({ name: errorName(result) }).toStrictEqual({
			name: 'ManifestSchemaInvalidError'
		});
	});

	it('rejects malformed target JSON without publishing a partial array', async () => {
		const calls: string[][] = [];
		const result = await resultOrError(
			evaluateTargetManifest(options, (arguments_) => {
				calls.push([...arguments_]);
				return Promise.resolve(
					arguments_.at(-1) === 'builtins.length' ? '1' : 'not-json'
				);
			})
		);
		expect({ name: errorName(result), calls }).toStrictEqual({
			name: 'ManifestJsonInvalidError',
			calls: [
				['eval', '--json', '.#targets', '--apply', 'builtins.length'],
				[
					'eval',
					'--json',
					'.#targets',
					'--apply',
					'targets: builtins.elemAt targets 0'
				]
			]
		});
	});

	it('removes only the top-level derivation field in the Nix projection', async () => {
		const calls: string[][] = [];
		const raw = {
			...target(0),
			components: [
				{
					attr: '.#component',
					rootDrvPath:
						'/nix/store/00000000000000000000000000000000-component.drv'
				}
			]
		};
		const manifest = await evaluateTargetManifest(
			{ ...options, publish: 'none' },
			(arguments_) => {
				calls.push([...arguments_]);
				return Promise.resolve(
					arguments_.at(-1) === 'builtins.length' ? '1' : JSON.stringify(raw)
				);
			}
		);
		const parsedManifest: unknown = JSON.parse(manifest);
		expect({ manifest: parsedManifest, calls }).toStrictEqual({
			manifest: [raw],
			calls: [
				['eval', '--json', '.#targets', '--apply', 'builtins.length'],
				[
					'eval',
					'--json',
					'.#targets',
					'--apply',
					'targets: builtins.removeAttrs (builtins.elemAt targets 0) [ "rootDrvPath" ]'
				]
			]
		});
	});

	it('does not force a removed derivation thunk or transform raw target fields', async () => {
		const fixture =
			'[ { attr = ".#package"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "/package/"; rootDrvPath = throw "top-level derivation forced"; } ]';
		const runner: ManifestRunner = async (arguments_) => {
			const result = await execFileAsync(
				'nix',
				[
					arguments_[0] ?? '',
					arguments_[1] ?? '',
					'--expr',
					fixture,
					...arguments_.slice(3)
				],
				{ encoding: 'utf8', maxBuffer: 1024 * 1024 }
			);
			return result.stdout;
		};
		const manifest = await evaluateTargetManifest(
			{ ...options, publish: 'none' },
			runner
		);
		expect(JSON.parse(manifest)).toStrictEqual([
			{
				attr: '.#package',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				rootSuffix: '/package/'
			}
		]);
	});

	it.each(['outputs', 'built', 'closure'])(
		'evaluates the top-level derivation in publish=%s',
		async (publish) => {
			const fixture =
				'[ { attr = ".#package"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "/package/"; rootDrvPath = throw "top-level derivation forced"; } ]';
			const runner: ManifestRunner = async (arguments_) => {
				const result = await execFileAsync(
					'nix',
					[
						arguments_[0] ?? '',
						arguments_[1] ?? '',
						'--expr',
						fixture,
						...arguments_.slice(3)
					],
					{ encoding: 'utf8', maxBuffer: 1024 * 1024 }
				);
				return result.stdout;
			};
			await expect(
				evaluateTargetManifest({ ...options, publish }, runner)
			).rejects.toThrow('top-level derivation forced');
		}
	);

	it('continues to evaluate component derivations in no-publish mode', async () => {
		const fixture =
			'[ { attr = ".#aggregate"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "aggregate"; rootDrvPath = throw "top-level derivation forced"; components = [ { attr = ".#component"; rootDrvPath = throw "component derivation forced"; } ]; } ]';
		const runner: ManifestRunner = async (arguments_) => {
			const result = await execFileAsync(
				'nix',
				[
					arguments_[0] ?? '',
					arguments_[1] ?? '',
					'--expr',
					fixture,
					...arguments_.slice(3)
				],
				{ encoding: 'utf8', maxBuffer: 1024 * 1024 }
			);
			return result.stdout;
		};
		await expect(
			evaluateTargetManifest({ ...options, publish: 'none' }, runner)
		).rejects.toThrow('component derivation forced');
	});

	it('joins active evaluations before reporting the first failure', async () => {
		const failure = new Error('First target failed');
		const pending = Promise.withResolvers<string>();
		const started = Promise.withResolvers<undefined>();
		const trace: string[] = [];
		const runner: ManifestRunner = async (arguments_, signal) => {
			if (arguments_.at(-1) === 'builtins.length') {
				return '6';
			}
			const index = Number(arguments_.at(-1)?.match(/ (\d+)$/u)?.[1]);
			trace.push(`start ${String(index)}`);
			if (index === 0) {
				return pending.promise;
			}
			const aborted = new Promise<void>((resolve) => {
				signal.addEventListener(
					'abort',
					() => {
						trace.push(`abort ${String(index)}`);
						resolve();
					},
					{ once: true }
				);
			});
			if (index === 3) {
				started.resolve(undefined);
			}
			await aborted;
			trace.push(`close ${String(index)}`);
			throw signal.reason;
		};
		const result = resultOrError(evaluateTargetManifest(options, runner));
		await started.promise;
		expect(trace).toStrictEqual(['start 0', 'start 1', 'start 2', 'start 3']);
		pending.reject(failure);
		const error = await result;
		expect({ error, trace }).toStrictEqual({
			error: failure,
			trace: [
				'start 0',
				'start 1',
				'start 2',
				'start 3',
				'abort 1',
				'abort 2',
				'abort 3',
				'close 1',
				'close 2',
				'close 3'
			]
		});
	});

	it.each([0, 1])(
		'includes array punctuation in the aggregate byte limit, short by %i byte',
		async (shortBy) => {
			const values = [target(0), target(1)];
			const complete = JSON.stringify(values);
			const calls: string[][] = [];
			let index = 0;
			const result = await resultOrError(
				evaluateTargetManifest(
					{
						...options,
						maximumOutputBytes: Buffer.byteLength(complete) - shortBy
					},
					(arguments_) => {
						calls.push([...arguments_]);
						return Promise.resolve(
							arguments_.at(-1) === 'builtins.length'
								? '2'
								: JSON.stringify(values[index++])
						);
					}
				)
			);
			expect({
				result: typeof result === 'string' ? result : errorName(result),
				calls
			}).toStrictEqual({
				result: shortBy === 0 ? complete : 'ManifestOutputLimitError',
				calls: [
					['eval', '--json', '.#targets', '--apply', 'builtins.length'],
					...[0, 1].map((value) => [
						'eval',
						'--json',
						'.#targets',
						'--apply',
						`targets: builtins.elemAt targets ${String(value)}`
					])
				]
			});
		}
	);

	it('rejects aggregate output before scheduling or retaining a complete oversized manifest', async () => {
		const trace: number[] = [];
		const result = await resultOrError(
			evaluateTargetManifest(
				{ ...options, maximumOutputBytes: 250 },
				(arguments_) => {
					if (arguments_.at(-1) === 'builtins.length') {
						return Promise.resolve('1000000');
					}
					const index = Number(arguments_.at(-1)?.match(/ (\d+)$/u)?.[1]);
					trace.push(index);
					return Promise.resolve(JSON.stringify(target(index)));
				}
			)
		);
		expect({ name: errorName(result), trace }).toStrictEqual({
			name: 'ManifestOutputLimitError',
			trace: [0, 1, 2, 3]
		});
	});
});
