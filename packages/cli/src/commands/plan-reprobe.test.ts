import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidCohortTargetsFileError,
	ReadCredentialPairError
} from '../errors.ts';
import type { DestinationAnswers } from '../plan/availability-partition.ts';
import type { ParsedCohortTarget } from '../plan/cohort-target.ts';

import { registerPlanCommands } from './plan-cohort.ts';
import { runPlanReprobe } from './plan-reprobe.ts';

function noop(): void {
	/* test double: nothing to record */
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const otherPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-other'
);
const appRoot = rootNameSchema.parse('github:owner/repo/main/app');

const appTarget: ParsedCohortTarget = {
	attr: 'packages.x86_64-linux.app',
	installable: appPath,
	expectedPath: appPath,
	root: appRoot
};
const otherTarget: ParsedCohortTarget = {
	attr: 'packages.x86_64-linux.other',
	installable: otherPath,
	expectedPath: otherPath,
	root: appRoot
};

function answers(served: readonly StorePathString[] = []): DestinationAnswers {
	return {
		destinationServed: () => Promise.resolve(new Set(served)),
		viewServed: () => Promise.resolve(new Set())
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

describe('runPlanReprobe', () => {
	it.each([
		{
			name: 'a build set nothing has caught up with',
			destination: [],
			expected: {
				buildSet: [appPath, otherPath],
				withdrawn: []
			},
			rows: [
				{ label: 'Withdrawn', value: '0' },
				{ label: 'Build set', value: '2' }
			]
		},
		{
			name: 'a target the destination has since gained',
			destination: [appPath],
			expected: {
				buildSet: [otherPath],
				withdrawn: [
					{
						installable: appPath,
						storePath: appPath,
						outcome: 'attachOnly'
					}
				]
			},
			rows: [
				{ label: 'Withdrawn', value: '1' },
				{ label: 'Build set', value: '1' }
			]
		}
	])('reports $name', async ({ destination, expected, rows }) => {
		const payloads: ResultPayload[] = [];
		const reprobe = await runPlanReprobe(
			{ targets: [appTarget, otherTarget] },
			reporter(payloads),
			{ destinationAnswers: answers(destination) }
		);

		expect(reprobe).toStrictEqual(expected);
		expect(payloads).toStrictEqual([
			{ kind: 'plan-reprobe', data: expected, rows }
		]);
	});
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

async function runReprobeCommand(
	arguments_: readonly string[]
): Promise<unknown> {
	try {
		await silentProgram().parseAsync(['plan', 'reprobe', ...arguments_], {
			from: 'user'
		});
	} catch (error: unknown) {
		return error;
	}

	return undefined;
}

const tenantUrl = 'https://cache.example.workers.dev/t/acme';

describe('plan reprobe command', () => {
	it.each([
		['is not JSON', 'not json'],
		[
			'does not match the cohort targets schema',
			JSON.stringify({ targets: [{ attr: 'app' }] })
		],
		[
			'names an installable outside the store',
			JSON.stringify({
				targets: [
					{ attr: 'app', installable: '/tmp/app', root: 'github:o/r/main/app' }
				]
			})
		]
	])(
		'rejects a targets file that %s before asking the destination',
		async (_name, contents) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-reprobe-')
			);
			const targetsFile = path.join(directory, 'targets.json');

			try {
				await writeFile(targetsFile, contents);

				const error = await runReprobeCommand([
					tenantUrl,
					'--targets-file',
					targetsFile
				]);

				expect(error).toBeInstanceOf(InvalidCohortTargetsFileError);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('refuses a read user supplied without its password', async () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), 'cupboard-plan-reprobe-')
		);
		const targetsFile = path.join(directory, 'targets.json');

		try {
			await writeFile(
				targetsFile,
				JSON.stringify({
					targets: [
						{
							attr: appTarget.attr,
							installable: appTarget.installable,
							expectedPath: appTarget.expectedPath,
							root: appTarget.root
						}
					]
				})
			);

			const error = await runReprobeCommand([
				tenantUrl,
				'--targets-file',
				targetsFile,
				'--read-user',
				'reader'
			]);

			expect(error).toBeInstanceOf(ReadCredentialPairError);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
