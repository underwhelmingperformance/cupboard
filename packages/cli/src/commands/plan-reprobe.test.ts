import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	createGithubReporter,
	type Reporter,
	type ResultPayload
} from '@cupboard/reporter';
import { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidCohortTargetsFileError } from '../errors.ts';
import type { DestinationProbes } from '../plan/availability-partition.ts';
import type { CohortTarget } from '../plan/cohort-target.ts';
import {
	accessKeyAuthorization,
	accessKeyVariables,
	destinationAccessKey,
	environmentAccessKeyCases,
	type RecordedRequest,
	sourceAccessKey,
	withRecordingServer
} from '../test-support.ts';

import { registerPlanCommands } from './plan-cohort.ts';
import { runPlanReprobe } from './plan-reprobe.ts';

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
const appRoot = rootNameSchema.parse('github:owner/repo/main/app');

const appTarget: CohortTarget = {
	attr: 'packages.x86_64-linux.app',
	installable: appPath,
	expectedPath: appPath,
	root: appRoot
};
const otherTarget: CohortTarget = {
	attr: 'packages.x86_64-linux.other',
	installable: otherPath,
	expectedPath: otherPath,
	root: appRoot
};

function answers(served: readonly StorePathString[] = []): DestinationProbes {
	return {
		destinationServed: () => Promise.resolve(new Set(served)),
		viewServed: () => Promise.resolve(new Set())
	};
}

function reporter(payloads: ResultPayload[]): Reporter {
	const record = (payload: ResultPayload): void => {
		payloads.push(payload);
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: noop, warn: noop, result: record })),
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
		result: record,
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
				{ label: 'Now available in the cache', value: '0' },
				{ label: 'To build', value: '2' }
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
				{ label: 'Now available in the cache', value: '1' },
				{ label: 'To build', value: '1' }
			]
		}
	])('reports $name', async ({ destination, expected, rows }) => {
		const payloads: ResultPayload[] = [];
		const reprobe = await runPlanReprobe(
			{ targets: [appTarget, otherTarget] },
			reporter(payloads),
			{ destinationProbes: answers(destination) }
		);

		expect(reprobe).toStrictEqual(expected);
		expect(payloads).toStrictEqual([
			{
				kind: 'plan-reprobe',
				title: 'Build plan refresh',
				data: expected,
				rows
			}
		]);
	});

	it('writes the refreshed plan inside the confirmation group in GitHub mode', async () => {
		const written: string[] = [];

		await runPlanReprobe(
			{ targets: [appTarget, otherTarget] },
			createGithubReporter({
				stream: new Writable({
					write(chunk: Buffer | string, _encoding, callback) {
						written.push(String(chunk));
						callback();
					}
				})
			}),
			{ destinationProbes: answers([appPath]) }
		);

		expect(written).toStrictEqual([
			'::group::Confirming the build set\n',
			'Now available in the cache: 1\n',
			'still to build: 1\n',
			'Build plan refresh\n',
			'Now available in the cache: 1\n',
			'To build: 1\n',
			'::endgroup::\n'
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

/**
Runs `plan reprobe` for one target against a recording server, with a
reference source in the same tenant, and returns the error and the requests
in path order.
*/
async function reprobeRequests(options: readonly string[]): Promise<{
	readonly error: unknown;
	readonly requests: readonly RecordedRequest[];
}> {
	const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-plan-reprobe-'));
	const targetsFile = path.join(directory, 'targets.json');

	try {
		await writeFile(targetsFile, JSON.stringify({ targets: [appTarget] }));

		return await withRecordingServer(
			(request) => ({
				status: StatusCodes.OK,
				body: JSON.stringify({
					missingStorePathHashes: request.path.startsWith(
						'/t/acme/cache/source/'
					)
						? []
						: ['0123456789abcdfghijklmnpqrsvwxyz']
				})
			}),
			async (origin, requests) => {
				const error = await runReprobeCommand([
					`${origin}/t/acme`,
					'--targets-file',
					targetsFile,
					'--reference-source',
					`${origin}/t/acme/cache/source`,
					...options
				]);

				return {
					error,
					requests: requests.toSorted((left, right) =>
						left.path.localeCompare(right.path)
					)
				};
			}
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe('plan reprobe command', () => {
	beforeEach(() => {
		for (const variable of accessKeyVariables) {
			vi.stubEnv(variable, undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(environmentAccessKeyCases)(
		'sends the key in $variable only to the $role',
		async ({ variable, key, role }) => {
			vi.stubEnv(variable, key);

			const credential = accessKeyAuthorization(key);

			expect(await reprobeRequests([])).toStrictEqual({
				error: undefined,
				requests: [
					{
						method: 'POST',
						path: '/t/acme/api/v1/missing-paths',
						authorization: role === 'destination' ? credential : undefined
					},
					{
						method: 'POST',
						path: '/t/acme/cache/source/api/v1/missing-paths',
						authorization: role === 'source' ? credential : undefined
					}
				]
			});
		}
	);

	it('sends the options in preference to the environment', async () => {
		vi.stubEnv('CUPBOARD_ACCESS_KEY', destinationAccessKey);
		vi.stubEnv('CUPBOARD_VIEW_ACCESS_KEY', sourceAccessKey);

		expect(
			await reprobeRequests([
				'--access-key',
				sourceAccessKey,
				'--view-access-key',
				destinationAccessKey
			])
		).toStrictEqual({
			error: undefined,
			requests: [
				{
					method: 'POST',
					path: '/t/acme/api/v1/missing-paths',
					authorization: accessKeyAuthorization(sourceAccessKey)
				},
				{
					method: 'POST',
					path: '/t/acme/cache/source/api/v1/missing-paths',
					authorization: accessKeyAuthorization(destinationAccessKey)
				}
			]
		});
	});

	it('does not read the view variable without a reuse view or reference source', async () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), 'cupboard-plan-credentials-')
		);
		const targetsFile = path.join(directory, 'targets.json');
		// Reading this value would fail, because it is not an access key.
		vi.stubEnv(
			'CUPBOARD_VIEW_ACCESS_KEY',
			'eyJhbGciOiJFZERTQSJ9.e30.signature'
		);

		try {
			await writeFile(targetsFile, 'not json');

			await expect(
				silentProgram().parseAsync(
					[
						'plan',
						'reprobe',
						'https://cache.example.workers.dev/t/acme',
						'--targets-file',
						targetsFile
					],
					{ from: 'user' }
				)
			).rejects.toBeInstanceOf(InvalidCohortTargetsFileError);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ variable: 'CUPBOARD_ACCESS_KEY', view: [] },
		{ variable: 'CUPBOARD_VIEW_ACCESS_KEY', view: ['--reuse-view', 'pr-view'] }
	])(
		'refuses an access token in $variable before reading targets',
		async ({ variable, view }) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-credentials-')
			);
			vi.stubEnv(variable, 'eyJhbGciOiJFZERTQSJ9.e30.signature');

			try {
				await expect(
					silentProgram().parseAsync(
						[
							'plan',
							'reprobe',
							'https://cache.example.workers.dev/t/acme',
							'--targets-file',
							path.join(directory, 'missing.json'),
							...view
						],
						{ from: 'user' }
					)
				).rejects.toMatchObject({
					name: 'InvalidAccessKeyError',
					source: variable
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

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
});
