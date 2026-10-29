import { cacheNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { readUserSchema } from '@cupboard/shared/http';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { describe, expect, it, vi } from 'vitest';

import {
	stalledResponse,
	untilOnlyStalledRequestPending
} from '../../../../tests/support/stalled-request.ts';

import { cacheReferenceSource, tenantProbesFor } from './destination-probe.ts';

const baseUrl = new URL('https://cupboard.example.test/t/owner');
const appHash = '0123456789abcdfghijklmnpqrsvwxyz';
const appPath = storePathSchema.parse(`/nix/store/${appHash}-app`);
interface ProbeRequest {
	readonly url: string;
	readonly authorization?: string;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

describe('tenantProbesFor read credentials', () => {
	it.each([401, 403])(
		'refuses a view read without a view credential with advice: %s',
		async (status) => {
			const requests: string[] = [];
			const probes = tenantProbesFor({
				baseUrl,
				cache: { kind: 'default' },
				view: 'reuse',
				credentials: {
					user: readUserSchema.parse('reader'),
					password: 'cache-only'
				},
				fetcher: (input) => {
					requests.push(requestUrl(input));
					return Promise.resolve(new Response(undefined, { status }));
				}
			});
			let error: unknown;
			try {
				await probes.viewServed([appPath]);
			} catch (error_) {
				error = error_;
			}
			expect({
				exitCode:
					typeof error === 'object' && error !== null && 'exitCode' in error
						? error.exitCode
						: undefined,
				message: error instanceof Error ? error.message : undefined
			}).toStrictEqual({
				exitCode: 77,
				message: `Could not read private reuse view at ${baseUrl.href}/reuse/reuse/api/v1/missing-paths: HTTP ${String(status)}. Supply the tenant read credential with --view-read-user and --view-read-password, or use an OIDC read session with view:content-read authority.`
			});
			expect(requests).toStrictEqual([
				`${baseUrl.href}/reuse/reuse/api/v1/missing-paths`
			]);
		}
	);
	it.each([
		{ name: 'separate view credentials', viewPassword: 'view-secret' },
		{ name: 'no credential for the view', viewPassword: undefined }
	])(
		'sends $name without changing destination reads',
		async ({ viewPassword }) => {
			const requests: ProbeRequest[] = [];
			const destination = {
				user: readUserSchema.parse('reader'),
				password: 'cache-secret'
			};
			const probes = tenantProbesFor({
				baseUrl,
				cache: { kind: 'named', name: cacheNameSchema.parse('builds') },
				view: 'reuse',
				credentials: destination,
				...(viewPassword !== undefined && {
					viewCredentials: {
						user: readUserSchema.parse('view-reader'),
						password: viewPassword
					}
				}),
				fetcher: (input, init) => {
					const url = requestUrl(input);
					const authorization = new Headers(init?.headers).get('authorization');
					requests.push({
						url,
						...(authorization !== null && { authorization })
					});
					return Promise.resolve(Response.json({ missingStorePathHashes: [] }));
				}
			});
			const destinationPaths = await probes.destinationServed([appPath]);
			const viewPaths = await probes.viewServed([appPath]);

			expect({
				destination: [...destinationPaths],
				view: [...viewPaths],
				requests
			}).toStrictEqual({
				destination: [appPath],
				view: [appPath],
				requests: [
					{
						url: `${baseUrl.href}/cache/builds/api/v1/missing-paths`,
						authorization: `Basic ${btoa('reader:cache-secret')}`
					},
					{
						url: `${baseUrl.href}/reuse/reuse/api/v1/missing-paths`,
						...(viewPassword !== undefined && {
							authorization: `Basic ${btoa(`view-reader:${viewPassword}`)}`
						})
					}
				]
			});
		}
	);
});

it.each([
	{ cache: { kind: 'default' } as const, suffix: '' },
	{
		cache: { kind: 'named', name: cacheNameSchema.parse('merged-pr') } as const,
		suffix: '/cache/merged-pr'
	}
])(
	'probes a cache reference source without treating it as destination availability: $suffix',
	async ({ cache, suffix }) => {
		const requests: ProbeRequest[] = [];
		const probes = tenantProbesFor({
			baseUrl,
			cache: { kind: 'named', name: cacheNameSchema.parse('pr') },
			referenceSource: { kind: 'cache', cache },
			viewCredentials: {
				user: readUserSchema.parse('source'),
				password: 'source-secret'
			},
			fetcher: (input, init) => {
				requests.push({
					url: requestUrl(input),
					authorization:
						new Headers(init?.headers).get('authorization') ?? undefined
				});
				return Promise.resolve(Response.json({ missingStorePathHashes: [] }));
			}
		});
		const served = await probes.viewServed([appPath]);
		expect({ served: [...served], requests }).toStrictEqual({
			served: [appPath],
			requests: [
				{
					url: `${baseUrl.href}${suffix}/api/v1/missing-paths`,
					authorization: `Basic ${btoa('source:source-secret')}`
				}
			]
		});
	}
);

it('builds when a reference cache has been removed without hiding a missing destination', async () => {
	const probes = tenantProbesFor({
		baseUrl,
		cache: { kind: 'default' },
		referenceSource: {
			kind: 'cache',
			cache: { kind: 'named', name: cacheNameSchema.parse('merged-pr') }
		},
		fetcher: () => Promise.resolve(new Response(undefined, { status: 404 }))
	});
	expect([...(await probes.viewServed([appPath]))]).toStrictEqual([]);
	await expect(probes.destinationServed([appPath])).rejects.toThrow('HTTP 404');
});

it.each([401, 403])(
	'does not hide reference cache read refusal: %s',
	async (status) => {
		const probes = tenantProbesFor({
			baseUrl,
			cache: { kind: 'default' },
			referenceSource: { kind: 'cache', cache: { kind: 'default' } },
			fetcher: () => Promise.resolve(new Response(undefined, { status }))
		});
		await expect(probes.viewServed([appPath])).rejects.toThrow(
			`HTTP ${String(status)}`
		);
	}
);

it('sends an availability request again after it hangs past the deadline', async () => {
	const missingHash = 'zyxwvsrqpnmlkjihgfdcba9876543210';
	const missingPath = storePathSchema.parse(`/nix/store/${missingHash}-gone`);
	const bodies: string[] = [];
	const probes = tenantProbesFor({
		baseUrl,
		cache: { kind: 'default' },
		fetcher: (_input, init) => {
			bodies.push(typeof init?.body === 'string' ? init.body : '');
			if (bodies.length === 1) {
				return stalledResponse(init?.signal);
			}
			return Promise.resolve(
				Response.json({ missingStorePathHashes: [missingHash] })
			);
		}
	});

	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	try {
		const pending = probes.destinationServed([appPath, missingPath]);
		const settled = expect(pending).resolves.toStrictEqual(new Set([appPath]));
		await untilOnlyStalledRequestPending(() => bodies.length === 1);
		await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);
		await settled;
	} finally {
		vi.useRealTimers();
	}

	const body = JSON.stringify({ storePathHashes: [appHash, missingHash] });
	expect(bodies).toStrictEqual([body, body]);
});

it('rejects a reference source outside the destination tenant', () => {
	expect(() =>
		cacheReferenceSource(
			baseUrl,
			new URL('https://cupboard.example.test/t/other')
		)
	).toThrow('destination tenant');
});

it('rejects a cache reference source combined with a reuse view', () => {
	expect(() =>
		tenantProbesFor({
			baseUrl,
			cache: { kind: 'default' },
			referenceSource: { kind: 'cache', cache: { kind: 'default' } },
			view: 'shared'
		})
	).toThrow('reuse-view');
});
