import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { fetch as undiciFetch, Response } from 'undici';
import { describe, expect, it } from 'vitest';

import {
	type PublicationSelectionOptions,
	selectPublicationPaths
} from './publication-selection.ts';
import {
	defaultSignatureSettings,
	type NixSubstitutionSettings
} from './store-config.ts';
import { resolveSubstitutableClosure } from './substitutable-closure.ts';
import { SubstituterClient } from './substituter.ts';

const app = storePathSchema.parse(
	'/nix/store/11111111111111111111111111111111-app'
);
const substitution: NixSubstitutionSettings = {
	substitute: true,
	substituters: ['https://upstream.example'],
	fallback: false,
	alwaysAllowSubstitutes: false
};
const tenantUrl = new URL('https://cupboard.example/t/acme');

function settings(substituters = substitution.substituters) {
	return {
		substitution: { ...substitution, substituters },
		signatures: { ...defaultSignatureSettings, requireSignatures: false }
	};
}

function store(
	queries: string[],
	isServed = true
): NonNullable<PublicationSelectionOptions['store']> {
	return {
		honoursSubstituterSettings: () => Promise.resolve({ isHonoured: true }),
		canSubstituteDerivation: () => Promise.resolve(true),
		resolveSubstitutableClosure: (storePath) => {
			queries.push(storePath);
			return Promise.resolve(
				isServed
					? { kind: 'served', pathCount: 1, narSize: 1, downloadSize: 1 }
					: { kind: 'not-served', storePath: app }
			);
		}
	};
}

describe('selectPublicationPaths', () => {
	it.each([
		{
			origin: 'built' as const,
			available: true,
			selected: [app],
			upstream: [],
			queries: []
		},
		{
			origin: 'store-held' as const,
			available: false,
			selected: [app],
			upstream: [],
			queries: [app]
		},
		{
			origin: 'store-held' as const,
			available: true,
			selected: [],
			upstream: [app],
			queries: [app]
		},
		{
			origin: 'copied' as const,
			available: true,
			selected: [],
			upstream: [app],
			queries: [app]
		}
	])(
		'selects $origin with external availability $available',
		async ({
			origin,
			available,
			selected,
			upstream,
			queries: expectedQueries
		}) => {
			const queries: string[] = [];
			const selection = await selectPublicationPaths(
				[{ storePath: app, origin }],
				{
					substituter: 'leave',
					settings: settings(),
					store: store(queries, available)
				}
			);
			expect({ selection, queries }).toStrictEqual({
				selection: { published: selected, leftUpstream: upstream },
				queries: expectedQueries
			});
		}
	);

	it.each([
		{
			description: 'a matching anonymous closure',
			narStatus: 206,
			signatureRequired: false,
			divergent: false,
			published: []
		},
		{
			description: 'a runtime NAR requiring credentials',
			narStatus: 403,
			signatureRequired: false,
			divergent: false,
			published: [app]
		},
		{
			description: 'an unsigned closure under signature policy',
			narStatus: 206,
			signatureRequired: true,
			divergent: false,
			published: [app]
		},
		{
			description: 'a different NAR under the same store path',
			narStatus: 206,
			signatureRequired: false,
			divergent: true,
			published: [app]
		}
	])(
		'selects publication for $description',
		async ({ narStatus, signatureRequired, divergent, published }) => {
			const directory = storeDirectorySchema.parse('/nix/store');
			const dependency = storePathSchema.parse(
				'/nix/store/22222222222222222222222222222222-lib'
			);
			const hash = NixSha256Hash.parsePrefixed(`sha256:${'22'.repeat(32)}`);
			const fetcher: typeof undiciFetch = (input) => {
				const url = new URL(
					typeof input === 'string' || input instanceof URL ? input : input.url
				);
				if (url.pathname.endsWith('.narinfo')) {
					const path = url.pathname.includes('111111') ? app : dependency;
					return Promise.resolve(
						new Response(
							[
								`StorePath: ${path}`,
								`URL: nar/${path === app ? 'app' : 'lib'}`,
								'Compression: none',
								`NarHash: sha256:${'22'.repeat(32)}`,
								'NarSize: 1000',
								'FileSize: 400',
								'References: '
							].join('\n') + '\n'
						)
					);
				}
				const status = url.pathname.endsWith('/app') ? 206 : narStatus;
				return Promise.resolve(
					new Response(new Uint8Array([1]), {
						status,
						headers: { 'content-range': 'bytes 0-0/400' }
					})
				);
			};
			const client = new SubstituterClient(
				[
					{
						uri: 'https://upstream.example',
						location: {
							kind: 'http',
							baseUrl: new URL('https://upstream.example')
						},
						storeDirectory: directory,
						hasMassQuery: true,
						isTrusted: false,
						priority: 0
					}
				],
				{
					storeDirectory: directory,
					substitute: true,
					fallback: true,
					requirePublicNar: true,
					fetch: fetcher
				}
			);
			const selection = await selectPublicationPaths(
				[{ storePath: app, origin: 'copied' }],
				{
					substituter: 'leave',
					tenantUrl,
					settings: {
						...settings(),
						signatures: {
							...defaultSignatureSettings,
							requireSignatures: signatureRequired
						}
					},
					store: {
						...store([]),
						resolveSubstitutableClosure: (path, options) =>
							resolveSubstitutableClosure(
								storePathSchema.parse(path),
								{
									heldLocally: (paths) =>
										Promise.resolve(
											paths.map((storePath) => ({
												storePath,
												narHash: divergent
													? NixSha256Hash.fromDigest(new Uint8Array(32))
													: hash,
												narSize: 1000,
												references: storePath === app ? [dependency] : [],
												signatures: [],
												ultimate: false
											}))
										),
									offered: (paths) => client.querySubstitutablePathInfos(paths)
								},
								options
							)
					}
				}
			);
			expect(selection).toStrictEqual({
				published,
				leftUpstream: published.length === 0 ? [app] : []
			});
		}
	);

	it.each(['', '/cache/release', '/reuse/default'])(
		'keeps a public tenant %s path selected',
		async (suffix) => {
			const queries: string[] = [];
			const selection = await selectPublicationPaths(
				[{ storePath: app, origin: 'copied' }],
				{
					substituter: 'leave',
					tenantUrl,
					settings: settings([`${tenantUrl.href}${suffix}`]),
					store: store(queries)
				}
			);
			expect({ selection, queries }).toStrictEqual({
				selection: { published: [app], leftUpstream: [] },
				queries: []
			});
		}
	);

	it('accepts a different tenant on the same deployment as external', async () => {
		const queries: string[] = [];
		const selection = await selectPublicationPaths(
			[{ storePath: app, origin: 'copied' }],
			{
				substituter: 'leave',
				tenantUrl,
				settings: settings(['https://cupboard.example/t/other']),
				store: store(queries)
			}
		);
		expect({ selection, queries }).toStrictEqual({
			selection: { published: [], leftUpstream: [app] },
			queries: [app]
		});
	});

	it('passes the signature policy to external closure verification', async () => {
		const selection = await selectPublicationPaths(
			[{ storePath: app, origin: 'copied' }],
			{
				substituter: 'leave',
				settings: {
					...settings(),
					signatures: {
						...defaultSignatureSettings,
						requireSignatures: true,
						trustedPublicKeys: []
					}
				},
				store: {
					...store([]),
					resolveSubstitutableClosure: async (_path, options) => {
						const accepted = await options?.accepts?.({
							storePath: app,
							source: 'substituter',
							references: [],
							signatures: [],
							fromTrustedSubstituter: false,
							narHash: NixSha256Hash.fromDigest(new Uint8Array(32)),
							narSize: 1,
							downloadSize: 1
						});
						return accepted
							? { kind: 'served', pathCount: 1, narSize: 1, downloadSize: 1 }
							: { kind: 'refused', storePath: app };
					}
				}
			}
		);
		expect(selection).toStrictEqual({ published: [app], leftUpstream: [] });
	});
});
