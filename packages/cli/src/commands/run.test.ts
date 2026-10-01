import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { discoverNixStoreConfig } from '@cupboard/nix';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import {
	readAccessFileEnvironment,
	readAccessGrantType
} from '@cupboard/protocol/read-access';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { describe, expect, it } from 'vitest';

import { abortable } from '../abort.ts';

import {
	RunCommandFailedError,
	runWithReadAccess,
	UnreadableReadCredentialFileError
} from './run.ts';

const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
const target = parseTenantCacheUrl(new URL(`${tenantUrl.href}/cache/builds`));
const configuration = discoverNixStoreConfig();
const lease = {
	user: 'cupboard-oidc',
	password: 'cupboard-access+jwt:example',
	expiresAtMs: Date.now() + 900_000
};

describe('cupboard run', () => {
	it('uses the renewal clock to calculate the issued credential expiry', async () => {
		const waits: number[] = [];

		await runWithReadAccess(
			target,
			['nix', 'build'],
			{ githubOidc: true },
			{
				environment: {
					ACTIONS_ID_TOKEN_REQUEST_URL: 'https://job.example/token',
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-secret'
				},
				storeConfig: configuration,
				readFile: () => Promise.resolve(''),
				renewal: {
					now: () => 0,
					wait: (milliseconds, signal) => {
						waits.push(milliseconds);

						return abortable(
							Promise.withResolvers<undefined>().promise,
							signal
						);
					}
				},
				fetcher: (input) =>
					Promise.resolve(
						(input instanceof Request ? input.url : String(input)).startsWith(
							'https://job.example/'
						)
							? Response.json({ value: 'signed-identity' })
							: Response.json({
									access_token: 'example',
									token_type: 'Bearer',
									expires_in: 900,
									authorization_details: [],
									read_resources: [
										{
											type: 'cupboard_cache',
											cache: target.cache,
											mode: 'content',
											state: {
												kind: 'existing',
												access: 'public',
												priority: 40
											}
										}
									]
								})
					),
				runChild: () => Promise.resolve({ status: 0, signal: undefined })
			}
		);

		expect(waits).toStrictEqual([600_000]);
	});

	it('keeps a static netrc credential while acquiring metadata-only configuration facts', async () => {
		const intents: unknown[] = [];
		let netrc: string | undefined;

		await runWithReadAccess(
			target,
			['nix', 'build'],
			{ githubOidc: true, cacheMetadata: true },
			{
				storeConfig: configuration,
				readFile: () =>
					Promise.resolve(
						'machine cupboard.example.workers.dev login static password secret\n'
					),
				issue: (input) => {
					intents.push(input.resources);
					return Promise.resolve(lease);
				},
				runChild: async ({ environment }) => {
					const file = /netrc-file = ([^\n]+)/u.exec(
						environment.NIX_CONFIG ?? ''
					)?.[1];

					if (file === undefined) {
						throw new Error('The child must receive its static netrc');
					}

					netrc = await readFile(file, 'utf8');

					return { status: 0, signal: undefined };
				}
			}
		);

		expect({ intents, netrc }).toStrictEqual({
			intents: [
				[{ type: 'cupboard_cache', cache: target.cache, mode: 'metadata' }]
			],
			netrc:
				'machine cupboard.example.workers.dev login static password secret\nmachine cupboard.example.workers.dev login static password secret\n'
		});
	});

	it('acquires exact configured intent without visibility probes and delivers protected facts', async () => {
		const extra = parseTenantCacheUrl(
			new URL(`${tenantUrl.href}/cache/falcon`)
		);
		const requests: { url: string; form: string | undefined }[] = [];
		let factsPath: string | undefined;
		let netrcPath: string | undefined;
		let delivered: unknown;
		const resources = [
			{
				type: 'cupboard_cache',
				cache: target.cache,
				mode: 'content',
				state: {
					kind: 'absent',
					firstWrite: { access: 'public', priority: 40 }
				}
			},
			{
				type: 'cupboard_cache',
				cache: extra.cache,
				mode: 'content',
				state: { kind: 'existing', access: 'private', priority: 40 }
			},
			{
				type: 'cupboard_view',
				view: 'prior',
				state: { kind: 'existing', access: 'public', priority: 50 }
			}
		];

		await runWithReadAccess(
			target,
			['nix', 'build'],
			{
				githubOidc: true,
				reuseView: reuseViewNameSchema.parse('prior'),
				readCaches: [extra]
			},
			{
				environment: {
					ACTIONS_ID_TOKEN_REQUEST_URL: 'https://job.example/token',
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job-secret',
					NIX_CONFIG: 'fallback = false'
				},
				storeConfig: configuration,
				readFile: () =>
					Promise.resolve(
						'machine other.example login another password static\n'
					),
				fetcher: (input, init) => {
					const url = input instanceof Request ? input.url : String(input);
					requests.push({
						url,
						form: typeof init?.body === 'string' ? init.body : undefined
					});

					return Promise.resolve(
						url.startsWith('https://job.example/')
							? Response.json({ value: 'signed-identity' })
							: Response.json({
									access_token: 'example',
									token_type: 'Bearer',
									expires_in: 900,
									authorization_details: [
										{
											type: 'cupboard_cache',
											cache: target.cache,
											actions: ['cache:read']
										}
									],
									read_resources: resources
								})
					);
				},
				runChild: async ({ environment }) => {
					factsPath = environment[readAccessFileEnvironment];
					netrcPath = /netrc-file = ([^\n]+)/u.exec(
						environment.NIX_CONFIG ?? ''
					)?.[1];

					if (factsPath === undefined || netrcPath === undefined) {
						throw new Error(
							'The child must receive the temporary netrc and resource facts'
						);
					}

					const facts: unknown = JSON.parse(await readFile(factsPath, 'utf8'));

					delivered = { facts, netrc: await readFile(netrcPath, 'utf8') };

					return { status: 0, signal: undefined };
				}
			}
		);

		expect({
			requests,
			delivered,
			removed: [factsPath, netrcPath].every(
				(file) => file !== undefined && !existsSync(file)
			)
		}).toStrictEqual({
			requests: [
				{
					url: 'https://job.example/token?audience=https%3A%2F%2Fcupboard.example.workers.dev%2Ft%2Facme',
					form: undefined
				},
				{
					url: `${tenantUrl.href}/token`,
					form: new URLSearchParams({
						grant_type: readAccessGrantType,
						subject_token: 'signed-identity',
						subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
						read_resources: JSON.stringify([
							{ type: 'cupboard_cache', cache: target.cache, mode: 'content' },
							{ type: 'cupboard_cache', cache: extra.cache, mode: 'content' },
							{ type: 'cupboard_view', view: 'prior' }
						])
					}).toString()
				}
			],
			delivered: {
				facts: {
					read_resources: resources,
					authorization_details: [
						{
							type: 'cupboard_cache',
							cache: target.cache,
							actions: ['cache:read']
						}
					]
				},
				netrc:
					'machine cupboard.example.workers.dev login cupboard-oidc password cupboard-access+jwt:example\nmachine other.example login another password static\n'
			},
			removed: true
		});
	});

	it('runs anonymous operations without inspecting credentials or contacting the server', async () => {
		let childEnvironment: NodeJS.ProcessEnv | undefined;

		await runWithReadAccess(
			target,
			['nix', 'build'],
			{},
			{
				environment: { NIX_CONFIG: 'fallback = false' },
				readFile: () => {
					throw new Error('Anonymous operation must not open the netrc');
				},
				fetcher: () => {
					throw new Error('Anonymous operation must not request an identity');
				},
				runChild: ({ environment }) => {
					childEnvironment = environment;
					return Promise.resolve({ status: 0, signal: undefined });
				}
			}
		);

		expect(childEnvironment).toStrictEqual({ NIX_CONFIG: 'fallback = false' });
	});

	it('acquires OIDC despite an incidental credential for the same host', async () => {
		const intents: unknown[] = [];
		await runWithReadAccess(
			target,
			['nix', 'build'],
			{ githubOidc: true, reuseView: reuseViewNameSchema.parse('prior') },
			{
				storeConfig: configuration,
				readFile: () =>
					Promise.resolve(
						'machine cupboard.example.workers.dev login other-tenant password secret\n'
					),
				issue: (input) => {
					intents.push(input.resources);
					return Promise.resolve(lease);
				},
				runChild: () => Promise.resolve({ status: 0, signal: undefined })
			}
		);
		expect(intents).toStrictEqual([
			[
				{ type: 'cupboard_cache', cache: target.cache, mode: 'content' },
				{ type: 'cupboard_view', view: 'prior' }
			]
		]);
	});

	it('rejects explicit URL credentials with OIDC content acquisition', async () => {
		await expect(
			runWithReadAccess(
				target,
				['nix', 'build'],
				{ githubOidc: true },
				{
					storeConfig: {
						...configuration,
						substitution: {
							...configuration.substitution,
							substituters: [
								'https://ci:secret@cupboard.example.workers.dev/t/acme/cache/builds/'
							]
						}
					},
					readFile: () => Promise.resolve(''),
					issue: () => {
						throw new Error(
							'Conflicting credentials must fail before exchange'
						);
					},
					runChild: () => {
						throw new Error(
							'Conflicting credentials must fail before child launch'
						);
					}
				}
			)
		).rejects.toMatchObject({ exitCode: 2 });
	});

	it('acquires one session for a deduplicated union of caches and a view', async () => {
		const extra = parseTenantCacheUrl(
			new URL(`${tenantUrl.href}/cache/falcon`)
		);
		const intents: unknown[] = [];
		await runWithReadAccess(
			target,
			['nix', 'build'],
			{
				githubOidc: true,
				readCaches: [extra, extra, target],
				reuseView: reuseViewNameSchema.parse('prior')
			},
			{
				storeConfig: configuration,
				readFile: () => Promise.resolve(''),
				issue: (input) => {
					intents.push(input.resources);
					return Promise.resolve(lease);
				},
				runChild: () => Promise.resolve({ status: 0, signal: undefined })
			}
		);
		expect(intents).toStrictEqual([
			[
				{ type: 'cupboard_cache', cache: target.cache, mode: 'content' },
				{ type: 'cupboard_cache', cache: extra.cache, mode: 'content' },
				{ type: 'cupboard_view', view: 'prior' }
			]
		]);
	});

	it('rejects additional read caches from a different tenant before exchange', async () => {
		const other = parseTenantCacheUrl(
			new URL('https://cupboard.example.workers.dev/t/other/cache/falcon')
		);
		await expect(
			runWithReadAccess(
				target,
				['nix', 'build'],
				{
					githubOidc: true,
					readCaches: [other]
				},
				{
					issue: () => {
						throw new Error('Cross-tenant resources must fail before exchange');
					},
					runChild: () => {
						throw new Error(
							'Cross-tenant resources must fail before child launch'
						);
					}
				}
			)
		).rejects.toMatchObject({ exitCode: 2 });
	});

	it('rejects read-session options without OIDC before launching the child', async () => {
		await expect(
			runWithReadAccess(
				target,
				['nix', 'build'],
				{ reuseView: reuseViewNameSchema.parse('prior') },
				{
					runChild: () => {
						throw new Error('Missing OIDC must fail before child launch');
					}
				}
			)
		).rejects.toMatchObject({ exitCode: 2 });
	});

	it('refuses to overwrite an unreadable netrc before exchange', async () => {
		await expect(
			runWithReadAccess(
				target,
				['nix', 'build'],
				{ githubOidc: true },
				{
					storeConfig: configuration,
					readFile: () =>
						Promise.reject(
							Object.assign(new Error('permission denied'), { code: 'EACCES' })
						),
					issue: () => {
						throw new Error('Issuance must not start');
					}
				}
			)
		).rejects.toBeInstanceOf(UnreadableReadCredentialFileError);
	});

	it.each([7, 23])(
		'propagates child status %s and removes session credentials',
		async (status) => {
			let netrcPath: string | undefined;

			await expect(
				runWithReadAccess(
					target,
					['nix', 'build'],
					{ githubOidc: true },
					{
						storeConfig: configuration,
						readFile: () => Promise.resolve(''),
						issue: () => Promise.resolve(lease),
						runChild: ({ environment }) => {
							netrcPath = /netrc-file = ([^\n]+)/u.exec(
								environment.NIX_CONFIG ?? ''
							)?.[1];
							return Promise.resolve({ status, signal: undefined });
						}
					}
				)
			).rejects.toMatchObject(new RunCommandFailedError(status, undefined));

			expect(netrcPath !== undefined && !existsSync(netrcPath)).toBe(true);
		}
	);
});
