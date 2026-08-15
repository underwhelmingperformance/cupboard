import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Nix, NixMissingPartition } from '@cupboard/nix';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidMeasureTargetsFileError,
	InvalidStoreUriError
} from '../errors.ts';
import type { ParsedMeasureTarget } from '../plan/cohort-target.ts';

import { registerPlanCommands } from './plan-cohort.ts';
import { type PlanMeasureResult, runPlanMeasure } from './plan-measure.ts';

function noop(): void {
	/*
	test double: nothing to record
	*/
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const otherPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-other'
);

const appTarget: ParsedMeasureTarget = {
	attr: 'packages.x86_64-linux.app',
	installable: appPath
};
const otherTarget: ParsedMeasureTarget = {
	attr: 'packages.x86_64-linux.other',
	installable: `${otherPath}^out`
};

function missing(downloadSize: number, narSize: number): NixMissingPartition {
	return {
		willBuild: [],
		willSubstitute: [],
		unknown: [],
		downloadSize,
		narSize
	};
}

// Answers each installable with its own partition, so a test proves the
// command asks per target rather than pricing the union.
function storeByInstallable(
	answers: ReadonlyMap<string, NixMissingPartition | Error>
): Pick<Nix, 'queryMissing'> {
	return {
		queryMissing(targets) {
			const [installable] = targets;

			if (installable === undefined || targets.length !== 1) {
				return Promise.reject(
					new Error('the measurement must query one installable at a time')
				);
			}

			const answer = answers.get(installable);

			if (answer === undefined) {
				return Promise.reject(
					new Error(`no answer configured for ${installable}`)
				);
			}

			return answer instanceof Error
				? Promise.reject(answer)
				: Promise.resolve(answer);
		}
	};
}

function reporter(payloads: ResultPayload[]): Reporter {
	return {
		phase: (_label, body) => Promise.resolve(body({ fact: noop, warn: noop })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: noop,
					group: () => ({ message: noop, success: noop, error: noop }),
					warn: noop
				})
			),
		result(payload) {
			payloads.push(payload);
		},
		data: noop,
		warn: noop,
		info: noop,
		success: noop,
		step: noop,
		error: noop
	};
}

describe('runPlanMeasure', () => {
	it.each([
		{
			name: 'per-target sizes for every priced target',
			answers: new Map<string, NixMissingPartition | Error>([
				[appTarget.installable, missing(100, 400)],
				[otherTarget.installable, missing(25, 75)]
			]),
			expected: {
				measurements: {
					[appTarget.attr]: { downloadSize: 100, narSize: 400 },
					[otherTarget.attr]: { downloadSize: 25, narSize: 75 }
				}
			},
			rows: [
				{ label: 'Measured', value: '2' },
				{ label: 'Unmeasured', value: '0' }
			]
		},
		{
			name: 'only the priced targets when one query fails',
			answers: new Map<string, NixMissingPartition | Error>([
				[appTarget.installable, new Error('daemon connection lost')],
				[otherTarget.installable, missing(25, 75)]
			]),
			expected: {
				measurements: {
					[otherTarget.attr]: { downloadSize: 25, narSize: 75 }
				}
			},
			rows: [
				{ label: 'Measured', value: '1' },
				{ label: 'Unmeasured', value: '1' }
			]
		},
		{
			name: 'no measurements at all when every query fails',
			answers: new Map<string, NixMissingPartition | Error>([
				[appTarget.installable, new Error('daemon connection lost')],
				[otherTarget.installable, new Error('daemon connection lost')]
			]),
			expected: { measurements: {} },
			rows: [
				{ label: 'Measured', value: '0' },
				{ label: 'Unmeasured', value: '2' }
			]
		}
	])(
		'writes and reports $name',
		async ({
			answers,
			expected,
			rows
		}: {
			readonly answers: ReadonlyMap<string, NixMissingPartition | Error>;
			readonly expected: PlanMeasureResult;
			readonly rows: readonly { label: string; value: string }[];
		}) => {
			const payloads: ResultPayload[] = [];
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-measure-')
			);
			const measureFile = path.join(directory, 'measure.json');

			try {
				await runPlanMeasure(
					{ targets: [appTarget, otherTarget], measureFile },
					reporter(payloads),
					{ store: storeByInstallable(answers) }
				);

				expect(JSON.parse(await readFile(measureFile, 'utf8'))).toStrictEqual(
					expected
				);
				expect(payloads).toStrictEqual([
					{
						kind: 'plan-measure',
						data: expected,
						rows: [...rows, { label: 'Measure file', value: measureFile }]
					}
				]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);
});

function silentProgram(): Command {
	const program = new Command();
	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	registerPlanCommands(program);

	return program;
}

async function runMeasureCommand(
	arguments_: readonly string[]
): Promise<unknown> {
	try {
		await silentProgram().parseAsync(['plan', 'measure', ...arguments_], {
			from: 'user'
		});
	} catch (error: unknown) {
		return error;
	}

	return undefined;
}

describe('plan measure command', () => {
	it('rejects a --store URI that names no ssh-ng destination before reading targets', async () => {
		const error = await runMeasureCommand([
			'--targets-file',
			'targets.json',
			'--store',
			'ssh://builder'
		]);

		expect(error).toBeInstanceOf(InvalidStoreUriError);

		if (!(error instanceof InvalidStoreUriError)) {
			return;
		}

		expect(error.value).toBe('ssh://builder');
	});

	it.each([
		['is not JSON', 'not json'],
		[
			'does not match the measure targets schema',
			JSON.stringify({ targets: [{ attr: 'app' }] })
		],
		[
			'names an installable outside the store',
			JSON.stringify({ targets: [{ attr: 'app', installable: '/tmp/app' }] })
		]
	])(
		'rejects a targets file that %s before opening the store',
		async (_name, contents) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-measure-')
			);
			const targetsFile = path.join(directory, 'targets.json');

			try {
				await writeFile(targetsFile, contents);

				const error = await runMeasureCommand(['--targets-file', targetsFile]);

				expect(error).toBeInstanceOf(InvalidMeasureTargetsFileError);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);
});
