import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
	evaluateTargetManifest,
	type ManifestRunner
} from './manifest-evaluator.ts';

const target = {
	attr: '.#package',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	rootSuffix: '/package/'
};
const options = { targets: '.#targets', publish: 'outputs' };
const execute = promisify(execFile);

function fixtureRunner(fixture: string): ManifestRunner {
	return async (arguments_) => {
		const result = await execute('nix', [
			'eval',
			'--json',
			'--expr',
			fixture,
			...arguments_.slice(3)
		]);
		return result.stdout;
	};
}

describe('whole-manifest evaluation', () => {
	it.each(['none', 'outputs', 'built', 'closure'])(
		'uses one Nix process for publish=%s',
		async (publish) => {
			const captured: string[][] = [];
			const manifest = await evaluateTargetManifest(
				{ ...options, publish },
				(arguments_) => {
					captured.push([...arguments_]);
					return Promise.resolve(
						JSON.stringify([target, { ...target, rootSuffix: '/second/' }])
					);
				}
			);
			const values: unknown = JSON.parse(manifest);
			expect({ calls: captured, values }).toStrictEqual({
				calls: [
					[
						'eval',
						'--json',
						'.#targets',
						'--apply',
						publish === 'none'
							? 'targets: builtins.map (target: builtins.removeAttrs target [ "rootDrvPath" ]) targets'
							: 'targets: targets'
					]
				],
				values: [target, { ...target, rootSuffix: '/second/' }]
			});
		}
	);

	it.each(['none', 'outputs', 'built', 'closure'])(
		'preserves derivation laziness for publish=%s',
		async (publish) => {
			const fixture =
				'[ { attr = ".#package"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "/package/"; rootDrvPath = throw "root forced"; } ]';
			const runner = fixtureRunner(fixture);
			const operation = evaluateTargetManifest({ ...options, publish }, runner);
			if (publish === 'none') {
				const values: unknown = JSON.parse(await operation);
				expect(values).toStrictEqual([
					{
						attr: '.#package',
						system: 'x86_64-linux',
						os: 'ubuntu-latest',
						rootSuffix: '/package/'
					}
				]);
				return;
			}
			await expect(operation).rejects.toThrow();
		}
	);

	it.each(['[]', '{}', '[{}]', 'invalid'])(
		'rejects an invalid complete result %s',
		async (output) => {
			await expect(
				evaluateTargetManifest(options, () => Promise.resolve(output))
			).rejects.toThrow();
		}
	);

	it('rejects canonical duplicate roots', async () => {
		await expect(
			evaluateTargetManifest(options, () =>
				Promise.resolve(
					JSON.stringify([
						target,
						{ ...target, attr: '.#other', rootSuffix: 'package' }
					])
				)
			)
		).rejects.toThrow('manifest is invalid');
	});

	it('still evaluates component derivations with publish=none', async () => {
		const runner = fixtureRunner(
			'[ { attr = ".#package"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "package"; rootDrvPath = throw "root forced"; components = [ { attr = ".#component"; rootDrvPath = throw "component forced"; } ]; } ]'
		);
		await expect(
			evaluateTargetManifest({ ...options, publish: 'none' }, runner)
		).rejects.toThrow('component forced');
	});

	it.each([0, -1])(
		'bounds the complete UTF-8 array at byte offset %i',
		async (offset) => {
			const output = JSON.stringify([{ ...target, attr: '.#λ' }]);
			const operation = evaluateTargetManifest(
				{ ...options, maximumOutputBytes: Buffer.byteLength(output) + offset },
				() => Promise.resolve(output)
			);
			if (offset === 0) {
				await expect(operation).resolves.toBe(output);
				return;
			}
			await expect(operation).rejects.toThrow('captured bytes');
		}
	);

	it.each(['before', 'during'])(
		'rejects external cancellation %s evaluation',
		async (when) => {
			const controller = new AbortController();
			const failure = new Error('Evaluation cancelled');
			const runner = vi.fn(() => {
				controller.abort(failure);
				return Promise.resolve(JSON.stringify([target]));
			});
			if (when === 'before') {
				controller.abort(failure);
			}
			await expect(
				evaluateTargetManifest(options, runner, controller.signal)
			).rejects.toBe(failure);
			expect(runner.mock.calls).toStrictEqual(
				when === 'before'
					? []
					: [
							[
								['eval', '--json', '.#targets', '--apply', 'targets: targets'],
								expect.any(AbortSignal),
								expect.any(Function)
							]
						]
			);
		}
	);

	it('reports the completed target count and elapsed time', async () => {
		const now = vi
			.spyOn(performance, 'now')
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(125);
		onTestFinished(() => {
			now.mockRestore();
		});
		const onProgress = vi.fn();
		await evaluateTargetManifest({ ...options, onProgress }, () =>
			Promise.resolve(JSON.stringify([target]))
		);
		expect(onProgress.mock.calls).toStrictEqual([
			[{ phase: 'manifest', status: 'started', elapsedMs: 0 }],
			[{ phase: 'manifest', status: 'completed', targets: 1, elapsedMs: 25 }]
		]);
	});

	it('does not accept output after the runner reports failure', async () => {
		const failure = new Error('evaluation failed');
		await expect(
			evaluateTargetManifest(options, (_arguments, _signal, onFailure) => {
				onFailure(failure);
				return Promise.resolve(JSON.stringify([target]));
			})
		).rejects.toBe(failure);
	});
});
