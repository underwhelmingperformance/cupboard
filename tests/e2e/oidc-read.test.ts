import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import {
	cacheUrl,
	parseTenantCacheUrl,
	reuseViewUrl
} from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema,
	type PermittedGrant
} from '@cupboard/protocol/grants';
import {
	type ReadAccessResponse,
	readAccessResponseSchema
} from '@cupboard/protocol/read-access';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { setupAction } from '../../actions/src/commands/setup.ts';
import { audienceSchema } from '../../packages/cli/src/audience.ts';
import { runChild } from '../../packages/cli/src/build-push/supervisor.ts';
import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { runWithReadAccess } from '../../packages/cli/src/commands/run.ts';
import { CupboardHttpError } from '../../packages/cli/src/errors.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/store-config.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { isolatedEnvironment, NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const audience = 'cupboard-read-ci';
const named: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
};
const view = reuseViewNameSchema.parse('prior');
const fixture = path.resolve(import.meta.dirname, '../fixtures/simple/source');

interface ReadCase {
	readonly access: CacheAccessMode;
	readonly content: boolean;
	readonly absent: boolean;
	readonly scope: CacheScope;
}

const cases: ReadCase[] = (['public', 'private'] as const).flatMap((access) =>
	[false, true].flatMap((content) => [
		{ access, content, absent: false, scope: { kind: 'default' } as const },
		{ access, content, absent: false, scope: named },
		{ access, content, absent: true, scope: named }
	])
);

async function expectReadAuthorityRefusal(
	request: Promise<ReadAccessResponse>,
	uncovered: AuthorizationDetails,
	advice: string
): Promise<void> {
	let error: unknown;
	try {
		await request;
	} catch (error_) {
		error = error_;
	}
	expect(error).toBeInstanceOf(CupboardHttpError);
	if (!(error instanceof CupboardHttpError)) {
		throw new Error('Expected a typed read authority refusal');
	}
	const body = z
		.strictObject({
			error: z.string(),
			error_description: z.string(),
			problem: z.string(),
			detail: z.strictObject({
				read_resources: z
					.string()
					.transform((value) =>
						authorizationDetailsSchema.parse(JSON.parse(value))
					)
			})
		})
		.parse(JSON.parse(error.body));
	expect({ status: error.status, body }).toStrictEqual({
		status: 400,
		body: {
			error: 'invalid_authorization_details',
			error_description: `The matching trust rules do not permit the requested read_resources. ${advice}`,
			problem: 'read-resources-not-permitted',
			detail: { read_resources: uncovered }
		}
	});
}

async function withReadFixture(
	testCase: ReadCase,
	body: (context: {
		server: CupboardTestServer;
		directory: string;
		subject: string;
		storePath: string;
		key: string;
		client: CupboardClient;
		publish: () => Promise<void>;
	}) => Promise<void>
): Promise<void> {
	await withTemporaryDirectory(
		'cupboard-oidc-read-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				provision: { defaultCacheAccess: testCase.access }
			});

			try {
				const owner = await server.ownerAdminToken();
				const rpc = tenantRpc(server.tenantUrl, { credential: owner });
				const permittedGrants: PermittedGrant[] = [
					{
						type: 'cupboard_cache',
						actions: [
							'upload:negotiate',
							'upload:commit',
							...(testCase.content ? ['cache:content-read' as const] : [])
						],
						resources: {
							cache:
								testCase.scope.kind === 'default'
									? { kind: 'default' }
									: {
											kind: 'named',
											exact: testCase.scope.name,
											validate: 'cacheName'
										}
						}
					}
				];

				await rpc.oidcTrust.add({
					issuer: server.issuer.issuer,
					audience,
					claims: { sub: 'ci' },
					permittedGrants
				});

				const { rules } = await rpc.oidcTrust.list();
				const ci = rules.find((rule) => rule.claims.sub === 'ci');

				expect(ci?.permittedGrants).toStrictEqual(permittedGrants);

				if (!testCase.absent && testCase.scope.kind === 'named') {
					await rpc.caches.put.inNamedCache({
						cacheName: testCase.scope.name,
						access: testCase.access,
						priority: 40
					});
				}

				const subject = server.issuer.sign({ aud: audience, sub: 'ci' });
				const source = await NixStore.host(path.join(directory, 'source-home'));
				const storePath = await source.add(fixture);
				const client = new CupboardClient(
					server.tenantUrl,
					fetch,
					testCase.scope
				);
				const key = await client.publicKey();
				const write: AuthorizationDetails = [
					{
						type: 'cupboard_cache',
						cache: testCase.scope,
						actions: ['upload:negotiate', 'upload:commit']
					}
				];
				const publication = await server.exchangeIdToken(subject, write);
				const publish = async () => {
					await pushStorePaths(
						{
							client: server.pushClient(publication, { cache: testCase.scope }),
							store: source
						},
						[storePath]
					);
				};

				if (!testCase.absent) {
					await publish();
				}

				await body({
					server,
					directory,
					subject,
					storePath,
					key,
					client,
					publish
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

async function substitute(
	context: {
		server: CupboardTestServer;
		directory: string;
		subject: string;
		storePath: string;
		key: string;
	},
	scope: CacheScope,
	reuse?: typeof view,
	isAnonymous = false,
	isViewOnly = false
): Promise<ReadAccessResponse[]> {
	const job = createServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ value: context.subject }));
	});
	job.listen(0, '127.0.0.1');
	await once(job, 'listening');
	const address = job.address() as AddressInfo;
	const environment = await isolatedEnvironment(
		path.join(context.directory, 'consumer-home')
	);
	const root = path.join(context.directory, 'consumer');
	const result: ReadAccessResponse[] = [];
	const urls = [
		...(isViewOnly ? [] : [cacheUrl(context.server.tenantUrl, scope)]),
		...(reuse === undefined
			? []
			: [reuseViewUrl(context.server.tenantUrl, reuse)])
	];

	try {
		await runWithReadAccess(
			isViewOnly
				? { tenantUrl: context.server.tenantUrl, view }
				: parseTenantCacheUrl(urls[0] ?? context.server.tenantUrl),
			[
				'nix-store',
				'--store',
				`local?root=${root}`,
				'--realise',
				context.storePath,
				'--option',
				'substituters',
				urls.map((url) => url.href).join(' '),
				'--option',
				'trusted-public-keys',
				context.key,
				'--option',
				'require-sigs',
				'true',
				'--option',
				'fallback',
				'false'
			],
			{
				githubOidc: !isAnonymous,
				...(!isViewOnly && reuse !== undefined && { reuseView: reuse }),
				...(!isAnonymous && { audience: audienceSchema.parse(audience) })
			},
			{
				environment: {
					...environment,
					...(!isAnonymous && {
						ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/token`,
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job'
					})
				},
				storeConfig: discoverNixStoreConfig(),
				readFile: () => Promise.resolve(''),
				fetcher: async (input, init) => {
					const response = await fetch(input, init);
					const url = input instanceof Request ? input.url : String(input);

					if (url === `${context.server.tenantUrl.href}/token` && response.ok) {
						result.push(
							readAccessResponseSchema.parse(await response.clone().json())
						);
					}

					return response;
				}
			}
		);

		expect(
			await readFile(path.join(root, context.storePath, 'message.txt'), 'utf8')
		).toBe('cupboard fixture\n');

		return result;
	} finally {
		job.close();
		job.closeAllConnections();
	}
}

describe('OIDC read acquisition and real Nix substitution', () => {
	it('renews through OIDC, then stops immediately and cleans up after revocation', () =>
		withReadFixture(
			{ access: 'private', content: true, absent: false, scope: named },
			async (context) => {
				const rpc = tenantRpc(context.server.tenantUrl, {
					credential: await context.server.ownerAdminToken()
				});
				const { rules } = await rpc.oidcTrust.list();
				const rule = rules.find((candidate) => candidate.claims.sub === 'ci');

				if (rule === undefined) {
					throw new Error('The renewal fixture must contain its CI rule');
				}

				let identities = 0;
				const clock = new ManualClock();
				const job = createServer((_request, response) => {
					identities++;

					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ value: context.subject }));
				});
				job.listen(0, '127.0.0.1');
				await once(job, 'listening');
				const address = job.address() as AddressInfo;
				const exchanges: { identity: number; status: number }[] = [];
				let netrcPath: string | undefined;
				let factsPath: string | undefined;
				const target = parseTenantCacheUrl(
					cacheUrl(context.server.tenantUrl, named)
				);
				const environment = await isolatedEnvironment(
					path.join(context.directory, 'renewal-home')
				);

				try {
					const session = runWithReadAccess(
						target,
						[
							process.execPath,
							'-e',
							"require('node:net').createServer().listen(0, '127.0.0.1')"
						],
						{ githubOidc: true, audience: audienceSchema.parse(audience) },
						{
							environment: {
								...environment,
								ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/token`,
								ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job'
							},
							storeConfig: discoverNixStoreConfig(),
							readFile: () => Promise.resolve(''),
							renewal: {
								now: clock.now,
								wait: clock.wait
							},
							fetcher: async (input, init) => {
								const response = await fetch(input, init);
								const url =
									input instanceof Request ? input.url : String(input);

								if (
									url.endsWith('/token') &&
									!url.includes(`:${String(address.port)}/`)
								) {
									exchanges.push({
										identity: identities,
										status: response.status
									});

									if (exchanges.length === 2) {
										await rpc.oidcTrust.remove({ id: rule.id });
										await rpc.oidcTrust.add({
											issuer: context.server.issuer.issuer,
											audience,
											claims: { sub: 'other-job' },
											permittedGrants: rule.permittedGrants
										});
									}
								}

								return response;
							},
							runChild: (input) => {
								netrcPath = /netrc-file = ([^\n]+)/u.exec(
									input.environment.NIX_CONFIG ?? ''
								)?.[1];
								factsPath = input.environment.CUPBOARD_READ_ACCESS_FILE;

								return runChild(input);
							}
						}
					);

					const refused = expect(session).rejects.toMatchObject({
						name: 'ReadCredentialRenewalError',
						exitCode: 77,
						cause: { status: 400 }
					});
					await clock.advanceThroughDelay(600_000);
					await clock.advanceThroughDelay(600_000);
					await refused;

					expect({
						exchanges,
						identities,
						filesRemoved: [netrcPath, factsPath].every(
							(file) => file !== undefined && !existsSync(file)
						)
					}).toStrictEqual({
						exchanges: [
							{ identity: 1, status: 200 },
							{ identity: 2, status: 200 },
							{ identity: 3, status: 400 }
						],
						identities: 3,
						filesRemoved: true
					});
				} finally {
					job.close();
					job.closeAllConnections();
				}
			}
		));

	it('configures and reads an absent public destination with a public view, then publishes implicitly without content grants', () =>
		withReadFixture(
			{ access: 'public', content: false, absent: true, scope: named },
			async (context) => {
				const owner = await context.server.ownerAdminToken();
				const rpc = tenantRpc(context.server.tenantUrl, { credential: owner });
				const sourceScope = {
					kind: 'named' as const,
					name: cacheNameSchema.parse('source')
				};
				const source = await NixStore.host(
					path.join(context.directory, 'view-source-home')
				);

				await rpc.caches.put.inNamedCache({
					cacheName: sourceScope.name,
					access: 'public',
					priority: 40
				});
				await pushStorePaths(
					{
						client: context.server.pushClient(owner, { cache: sourceScope }),
						store: source
					},
					[context.storePath]
				);
				await rpc.reuseViews.set({
					name: view,
					access: 'public',
					priority: 80,
					selectors: [{ kind: 'named', name: sourceScope.name }]
				});
				const { rules: before } = await rpc.oidcTrust.list();
				const job = createServer((_request, response) => {
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(JSON.stringify({ value: context.subject }));
				});

				job.listen(0, '127.0.0.1');
				await once(job, 'listening');
				const address = job.address() as AddressInfo;
				const environment = {
					...(await isolatedEnvironment(
						path.join(context.directory, 'setup-home')
					)),
					RUNNER_TEMP: context.directory,
					GITHUB_ENV: path.join(context.directory, 'github-env'),
					GITHUB_OUTPUT: path.join(context.directory, 'github-output'),
					ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/token`,
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'job'
				};

				try {
					await setupAction(
						{
							installDir: path.join(context.directory, 'bin'),
							addToPath: 'false',
							cacheUrl: context.server.tenantUrl.href,
							cache: 'builds',
							reuseView: view,
							cacheAccessMode: 'public',
							trustedPublicKey: context.key
						},
						environment,
						createGithubReporter(),
						{
							installRelease: () =>
								Promise.resolve({
									binaryPath: '/unused/cupboard',
									version: 'v1.2.3',
									sourceCommit: 'a'.repeat(40)
								}),
							configureWithReadAccess: async (
								_binaryPath,
								inputs,
								target,
								selectedView
							) => {
								const payload = path.join(
									context.directory,
									'setup-payload.json'
								);

								await writeFile(
									payload,
									JSON.stringify({
										...inputs,
										cacheUrl: inputs.cacheUrl.href,
										privateSubstituters: []
									}),
									{ mode: 0o600 }
								);
								await runWithReadAccess(
									parseTenantCacheUrl(target),
									[
										process.execPath,
										'--experimental-transform-types',
										'--disable-warning=ExperimentalWarning',
										path.resolve(
											import.meta.dirname,
											'../../actions/src/main.ts'
										),
										'setup-configure',
										'--input-file',
										payload
									],
									{
										githubOidc: true,
										audience: audienceSchema.parse(audience),
										reuseView: reuseViewNameSchema.parse(selectedView)
									},
									{
										environment,
										storeConfig: discoverNixStoreConfig(),
										readFile: () => Promise.resolve('')
									}
								);
							}
						}
					);

					const configured = await context.client.acquireReadAccess(
						context.subject,
						[{ type: 'cupboard_cache', cache: named, mode: 'content' }]
					);

					expect(configured.read_resources).toStrictEqual([
						{
							type: 'cupboard_cache',
							cache: named,
							mode: 'content',
							state: {
								kind: 'absent',
								firstWrite: { access: 'public', priority: 40 }
							}
						}
					]);
					const first = await substitute(
						{
							...context,
							directory: path.join(context.directory, 'before-push')
						},
						named,
						view
					);

					expect(
						first.map((response) => response.authorization_details)
					).toStrictEqual([
						[{ type: 'cupboard_cache', cache: named, actions: ['cache:read'] }]
					]);

					await context.publish();
					await substitute(
						{
							...context,
							directory: path.join(context.directory, 'after-push')
						},
						named
					);

					const { rules: after } = await rpc.oidcTrust.list();

					expect(after).toStrictEqual(before);
					const cache = await rpc.caches.get.inNamedCache({
						cacheName: cacheNameSchema.parse('builds')
					});

					expect({
						access: cache.access,
						priority: cache.priority
					}).toStrictEqual({ access: 'public', priority: 40 });
				} finally {
					job.close();
					job.closeAllConnections();
				}
			}
		));

	it.each(
		(['public', 'private'] as const).flatMap((access) =>
			[false, true].map((content) => ({ access, content }))
		)
	)('$access view with content grant $content', (testCase) =>
		withReadFixture(
			{ ...testCase, absent: false, scope: named },
			async (context) => {
				const rpc = tenantRpc(context.server.tenantUrl, {
					credential: await context.server.ownerAdminToken()
				});

				await rpc.reuseViews.set({
					name: view,
					access: testCase.access,
					selectors: [{ kind: 'named', name: cacheNameSchema.parse('builds') }]
				});
				const permittedGrants: PermittedGrant[] = [
					testCase.content
						? {
								type: 'cupboard_view',
								actions: ['view:content-read'],
								resources: { view: { exact: view, validate: 'reuseViewName' } }
							}
						: {
								type: 'cupboard_cache',
								actions: ['upload:negotiate'],
								resources: {
									cache: {
										kind: 'named',
										exact: 'unrelated',
										validate: 'cacheName'
									}
								}
							}
				];

				await rpc.oidcTrust.add({
					issuer: context.server.issuer.issuer,
					audience,
					claims: { sub: 'view-ci' },
					permittedGrants
				});
				const subject = context.server.issuer.sign({
					aud: audience,
					sub: 'view-ci'
				});
				const resources = [{ type: 'cupboard_view' as const, view }];

				if (testCase.access === 'private' && !testCase.content) {
					await expectReadAuthorityRefusal(
						context.client.acquireReadAccess(subject, resources),
						[{ type: 'cupboard_view', actions: ['view:content-read'], view }],
						"Add view:content-read for reuse view 'prior'."
					);

					return;
				}

				const responses = await substitute(
					{ ...context, subject },
					named,
					view,
					false,
					true
				);
				const grants: AuthorizationDetails = testCase.content
					? [{ type: 'cupboard_view', view, actions: ['view:content-read'] }]
					: [];

				expect(
					responses.map((response) => response.authorization_details)
				).toStrictEqual([grants]);

				if (testCase.access !== 'private') {
					await rpc.reuseViews.set({
						name: view,
						access: 'private',
						selectors: [
							{ kind: 'named', name: cacheNameSchema.parse('builds') }
						]
					});
					const token = responses[0]?.access_token;
					const transitioned = await fetch(
						`${reuseViewUrl(context.server.tenantUrl, view).href}/nix-cache-info`,
						{
							headers: {
								authorization: `Basic ${Buffer.from(`cupboard-oidc:cupboard-access+jwt:${token ?? ''}`).toString('base64')}`
							}
						}
					);

					expect(transitioned.status).toBe(testCase.content ? 200 : 401);

					return;
				}

				const token = responses[0]?.access_token;
				const direct = await fetch(
					`${cacheUrl(context.server.tenantUrl, named).href}/nix-cache-info`,
					{
						headers: {
							authorization: `Basic ${Buffer.from(`cupboard-oidc:cupboard-access+jwt:${token ?? ''}`).toString('base64')}`
						}
					}
				);

				expect(direct.status).toBe(401);
			}
		)
	);

	it.each(['both', 'cache-only', 'view-only'] as const)(
		'requires both exact grants for combined private targets: %s',
		(authority) =>
			withReadFixture(
				{ access: 'private', content: true, absent: false, scope: named },
				async (context) => {
					const rpc = tenantRpc(context.server.tenantUrl, {
						credential: await context.server.ownerAdminToken()
					});
					const permittedGrants: PermittedGrant[] = [
						...(authority === 'view-only'
							? []
							: [
									{
										type: 'cupboard_cache' as const,
										actions: ['cache:content-read' as const],
										resources: {
											cache: {
												kind: 'named' as const,
												exact: 'builds',
												validate: 'cacheName' as const
											}
										}
									}
								]),
						...(authority === 'cache-only'
							? []
							: [
									{
										type: 'cupboard_view' as const,
										actions: ['view:content-read' as const],
										resources: {
											view: { exact: view, validate: 'reuseViewName' as const }
										}
									}
								])
					];

					await rpc.reuseViews.set({
						name: view,
						access: 'private',
						selectors: [
							{ kind: 'named', name: cacheNameSchema.parse('builds') }
						]
					});
					await rpc.oidcTrust.add({
						issuer: context.server.issuer.issuer,
						audience,
						claims: { sub: 'combined' },
						permittedGrants
					});
					const subject = context.server.issuer.sign({
						aud: audience,
						sub: 'combined'
					});

					if (authority !== 'both') {
						await expectReadAuthorityRefusal(
							context.client.acquireReadAccess(subject, [
								{ type: 'cupboard_cache', cache: named, mode: 'content' },
								{ type: 'cupboard_view', view }
							]),
							[
								authority === 'cache-only'
									? {
											type: 'cupboard_view',
											actions: ['view:content-read'],
											view
										}
									: {
											type: 'cupboard_cache',
											actions: ['cache:content-read'],
											cache: named
										}
							],
							authority === 'cache-only'
								? "Add view:content-read for reuse view 'prior'."
								: "Add cache:content-read for cache 'builds'."
						);

						return;
					}

					const responses = await substitute(
						{ ...context, subject },
						named,
						view
					);

					expect(
						responses.map((response) => response.authorization_details)
					).toStrictEqual([
						[
							{
								type: 'cupboard_cache',
								cache: named,
								actions: ['cache:content-read']
							},
							{ type: 'cupboard_view', view, actions: ['view:content-read'] }
						]
					]);
				}
			)
	);

	it('substitutes anonymously without a matching identity or a token request', () =>
		withReadFixture(
			{ access: 'public', content: false, absent: false, scope: named },
			async (context) => {
				const before = context.server.requests.filter((request) =>
					request.path.endsWith('/token')
				).length;
				const output = path.join(context.directory, 'anonymous-output');

				await setupAction(
					{
						installDir: path.join(context.directory, 'anonymous-bin'),
						addToPath: 'false',
						cacheUrl: context.server.tenantUrl.href,
						cache: 'builds',
						trustedPublicKey: context.key
					},
					{
						RUNNER_TEMP: context.directory,
						GITHUB_ENV: path.join(context.directory, 'anonymous-env'),
						GITHUB_OUTPUT: output
					},
					createGithubReporter(),
					{
						installRelease: () =>
							Promise.resolve({
								binaryPath: '/unused/cupboard',
								version: 'v1.2.3',
								sourceCommit: 'a'.repeat(40)
							}),
						configureWithReadAccess: () => {
							throw new Error('Public setup must not acquire OIDC access');
						}
					}
				);

				expect(await readFile(output, 'utf8')).toContain(
					'read-session-target=\n'
				);
				const responses = await substitute(
					{
						...context,
						subject: context.server.issuer.sign({
							aud: audience,
							sub: 'unregistered'
						})
					},
					named,
					undefined,
					true
				);

				expect({
					responses,
					exchanges:
						context.server.requests.filter((request) =>
							request.path.endsWith('/token')
						).length - before
				}).toStrictEqual({ responses: [], exchanges: 0 });
			}
		));

	it.each(cases)(
		'$access $scope.kind cache: content grant $content, initially absent $absent',
		(testCase) =>
			withReadFixture(testCase, async (context) => {
				const resources = [
					{
						type: 'cupboard_cache' as const,
						cache: testCase.scope,
						mode: 'content' as const
					}
				];

				if (
					testCase.access === 'private' &&
					!testCase.content &&
					!testCase.absent
				) {
					await expectReadAuthorityRefusal(
						context.client.acquireReadAccess(context.subject, resources),
						[
							{
								type: 'cupboard_cache',
								actions: ['cache:content-read'],
								cache: testCase.scope
							}
						],
						testCase.scope.kind === 'default'
							? 'Add cache:content-read for the default cache.'
							: "Add cache:content-read for cache 'builds'."
					);

					return;
				}

				const acquired = await context.client.acquireReadAccess(
					context.subject,
					resources
				);
				const expectedGrants: AuthorizationDetails = testCase.content
					? [
							{
								type: 'cupboard_cache',
								cache: testCase.scope,
								actions: ['cache:content-read']
							}
						]
					: testCase.absent
						? [
								{
									type: 'cupboard_cache',
									cache: testCase.scope,
									actions: ['cache:read']
								}
							]
						: [];

				const payload = acquired.access_token.split('.', 2)[1];

				if (payload === undefined) {
					throw new Error('The acquired token must be a signed JWT');
				}

				const jwt = z
					.object({ authorization_details: authorizationDetailsSchema })
					.parse(
						JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
					);

				expect({
					grants: acquired.authorization_details,
					jwt: jwt.authorization_details,
					lifetime: acquired.expires_in,
					refresh: acquired.refresh_token
				}).toStrictEqual({
					grants: expectedGrants,
					jwt: expectedGrants,
					lifetime: 900,
					refresh: undefined
				});

				if (testCase.absent) {
					expect(acquired.read_resources).toStrictEqual([
						{
							...resources[0],
							state: {
								kind: 'absent',
								firstWrite: { access: testCase.access, priority: 40 }
							}
						}
					]);
					const headers = {
						authorization: `Basic ${Buffer.from(`cupboard-oidc:cupboard-access+jwt:${acquired.access_token}`).toString('base64')}`
					};
					const url = new URL(
						`${cacheUrl(context.server.tenantUrl, testCase.scope).href}/nix-cache-info`
					);
					const absent = await fetch(url, { headers });

					expect({
						status: absent.status,
						cacheControl: absent.headers.get('cache-control')
					}).toStrictEqual({ status: 404, cacheControl: 'no-store' });

					await context.publish();

					if (testCase.access === 'private' && !testCase.content) {
						const privateRead = await fetch(url, { headers });

						expect(privateRead.status).toBe(401);
						await expectReadAuthorityRefusal(
							context.client.acquireReadAccess(context.subject, resources),
							[
								{
									type: 'cupboard_cache',
									actions: ['cache:content-read'],
									cache: testCase.scope
								}
							],
							"Add cache:content-read for cache 'builds'."
						);

						return;
					}
				}

				const responses = await substitute(context, testCase.scope);

				expect(
					responses.map((response) => response.authorization_details)
				).toStrictEqual([testCase.content ? expectedGrants : []]);
				expect(
					context.server.requests.some(
						(request) =>
							request.path.endsWith('.narinfo') && request.status === 200
					)
				).toBe(true);

				expect(
					context.server.requests.some(
						(request) =>
							request.path.includes('/nar/') && request.status === 200
					)
				).toBe(true);

				if (
					testCase.absent ||
					testCase.scope.kind !== 'named' ||
					testCase.access !== 'public'
				) {
					return;
				}

				const rpc = tenantRpc(context.server.tenantUrl, {
					credential: await context.server.ownerAdminToken()
				});

				await rpc.caches.update.inNamedCache({
					kind: 'access',
					cacheName: testCase.scope.name,
					access: 'private'
				});
				const transitioned = await fetch(
					`${cacheUrl(context.server.tenantUrl, testCase.scope).href}/nix-cache-info`,
					{
						headers: {
							authorization: `Basic ${Buffer.from(`cupboard-oidc:cupboard-access+jwt:${acquired.access_token}`).toString('base64')}`
						}
					}
				);

				expect(transitioned.status).toBe(testCase.content ? 200 : 401);
			})
	);
});
