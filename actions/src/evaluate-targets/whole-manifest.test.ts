import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
	evaluateWholeManifest,
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

describe('whole-manifest evaluation', () => {
	it.each(['none', 'outputs', 'built', 'closure'])(
		'uses one Nix process for publish=%s',
		async (publish) => {
			const captured: string[][] = [];
			const manifest = await evaluateWholeManifest(
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

	it.each(['none', 'outputs'])(
		'preserves derivation laziness for publish=%s',
		async (publish) => {
			const fixture =
				'[ { attr = ".#package"; system = "x86_64-linux"; os = "ubuntu-latest"; rootSuffix = "/package/"; rootDrvPath = throw "root forced"; } ]';
			const runner: ManifestRunner = async (arguments_) => {
				const result = await execute('nix', [
					'eval',
					'--json',
					'--expr',
					fixture,
					...arguments_.slice(3)
				]);
				return result.stdout;
			};
			const operation = evaluateWholeManifest({ ...options, publish }, runner);
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
				evaluateWholeManifest(options, () => Promise.resolve(output))
			).rejects.toThrow();
		}
	);

	it('rejects oversized output before parsing it', async () => {
		await expect(
			evaluateWholeManifest({ ...options, maximumOutputBytes: 1 }, () =>
				Promise.resolve(JSON.stringify([target]))
			)
		).rejects.toThrow('captured bytes');
	});

	it('does not accept output after the runner reports failure', async () => {
		const failure = new Error('evaluation failed');
		await expect(
			evaluateWholeManifest(options, (_arguments, _signal, onFailure) => {
				onFailure(failure);
				return Promise.resolve(JSON.stringify([target]));
			})
		).rejects.toBe(failure);
	});
});
