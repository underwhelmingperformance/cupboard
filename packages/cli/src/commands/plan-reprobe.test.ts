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
	basicAuthorization,
	environmentCredentialCases,
	readCredentialVariables,
	type RecordedRequest,
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
		for (const variable of readCredentialVariables) {
			vi.stubEnv(variable, undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(environmentCredentialCases)(
		'pairs $flag with $variable from the environment for the $role',
		async ({ flag, value, variable, variableValue, role }) => {
			vi.stubEnv(variable, variableValue);

			const credential = basicAuthorization('reader', 'synthetic-secret');

			expect(await reprobeRequests([flag, value])).toStrictEqual({
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

	it.each<{
		readonly name: string;
		readonly environment: Readonly<Record<string, string>>;
		readonly options: readonly string[];
		readonly destination: { readonly user: string; readonly password: string };
		readonly source:
			{ readonly user: string; readonly password: string } | undefined;
	}>([
		{
			name: 'the environment',
			environment: {
				CUPBOARD_READ_USER: 'destination-reader',
				CUPBOARD_READ_PASSWORD: 'destination-secret',
				CUPBOARD_VIEW_READ_USER: 'source-reader',
				CUPBOARD_VIEW_READ_PASSWORD: 'source-secret'
			},
			options: [],
			destination: {
				user: 'destination-reader',
				password: 'destination-secret'
			},
			source: { user: 'source-reader', password: 'source-secret' }
		},
		{
			name: 'options in preference to the environment',
			environment: {
				CUPBOARD_READ_USER: 'destination-reader',
				CUPBOARD_READ_PASSWORD: 'destination-secret',
				CUPBOARD_VIEW_READ_USER: 'source-reader',
				CUPBOARD_VIEW_READ_PASSWORD: 'source-secret'
			},
			options: [
				'--read-user',
				'option-destination-reader',
				'--read-password',
				'option-destination-secret',
				'--view-read-user',
				'option-source-reader',
				'--view-read-password',
				'option-source-secret'
			],
			destination: {
				user: 'option-destination-reader',
				password: 'option-destination-secret'
			},
			source: { user: 'option-source-reader', password: 'option-source-secret' }
		},
		{
			name: 'user options and environment passwords',
			environment: {
				CUPBOARD_READ_PASSWORD: 'destination-secret',
				CUPBOARD_VIEW_READ_PASSWORD: 'source-secret'
			},
			options: [
				'--read-user',
				'destination-reader',
				'--view-read-user',
				'source-reader'
			],
			destination: {
				user: 'destination-reader',
				password: 'destination-secret'
			},
			source: { user: 'source-reader', password: 'source-secret' }
		},
		{
			name: 'the destination variables without a source credential',
			environment: {
				CUPBOARD_READ_USER: 'destination-reader',
				CUPBOARD_READ_PASSWORD: 'destination-secret'
			},
			options: [],
			destination: {
				user: 'destination-reader',
				password: 'destination-secret'
			},
			source: undefined
		}
	])(
		'sends each cache its own credential from $name',
		async ({ environment, options, destination, source }) => {
			for (const [variable, value] of Object.entries(environment)) {
				vi.stubEnv(variable, value);
			}

			expect(await reprobeRequests(options)).toStrictEqual({
				error: undefined,
				requests: [
					{
						method: 'POST',
						path: '/t/acme/api/v1/missing-paths',
						authorization: basicAuthorization(
							destination.user,
							destination.password
						)
					},
					{
						method: 'POST',
						path: '/t/acme/cache/source/api/v1/missing-paths',
						authorization:
							source === undefined
								? undefined
								: basicAuthorization(source.user, source.password)
					}
				]
			});
		}
	);

	const destinationVariables = {
		user: 'CUPBOARD_READ_USER',
		password: 'CUPBOARD_READ_PASSWORD'
	};
	const viewVariables = {
		user: 'CUPBOARD_VIEW_READ_USER',
		password: 'CUPBOARD_VIEW_READ_PASSWORD'
	};

	it('does not read the view variables without a reuse view or reference source', async () => {
		const directory = mkdtempSync(
			path.join(tmpdir(), 'cupboard-plan-credentials-')
		);
		const targetsFile = path.join(directory, 'targets.json');
		vi.stubEnv('CUPBOARD_VIEW_READ_USER', 'source-reader');

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
		{
			flag: '--read-user',
			value: 'reader',
			view: [],
			variables: destinationVariables
		},
		{
			flag: '--read-password',
			value: 'synthetic-secret',
			view: [],
			variables: destinationVariables
		},
		{
			flag: '--view-read-user',
			value: 'reader',
			view: ['--reuse-view', 'pr-view'],
			variables: viewVariables
		},
		{
			flag: '--view-read-password',
			value: 'synthetic-secret',
			view: ['--reuse-view', 'pr-view'],
			variables: viewVariables
		}
	])(
		'rejects an incomplete $flag pair before reading targets',
		async ({ flag, value, view, variables }) => {
			const directory = mkdtempSync(
				path.join(tmpdir(), 'cupboard-plan-credentials-')
			);

			try {
				await expect(
					silentProgram().parseAsync(
						[
							'plan',
							'reprobe',
							'https://cache.example.workers.dev/t/acme',
							'--targets-file',
							path.join(directory, 'missing.json'),
							flag,
							value,
							...view
						],
						{ from: 'user' }
					)
				).rejects.toMatchObject({
					name: 'ReadCredentialPairError',
					variables
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
