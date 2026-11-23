import { cacheNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { describe, expect, it } from 'vitest';

import { ManualDeadlineTimer } from '../../../../tests/support/manual-deadline-timer.ts';
import { stalledResponse } from '../../../../tests/support/stalled-request.ts';
import { basicCredentialForAccessKey } from '../access-key-options.ts';
import {
	accessKeyAuthorization,
	destinationAccessKey,
	sourceAccessKey
} from '../test-support.ts';

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

describe('tenantProbesFor access keys', () => {
	it.each([401, 403])(
		'refuses a view read without a view access key with advice: %s',
		async (status) => {
			const requests: string[] = [];
			const probes = tenantProbesFor({
				baseUrl,
				cache: { kind: 'default' },
				view: 'reuse',
				credentials: basicCredentialForAccessKey(destinationAccessKey),
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
				message: `Could not read private reuse view at ${baseUrl.href}/reuse/reuse/api/v1/missing-paths: HTTP ${String(status)}. Supply an access key with view:content-read for the view with --view-access-key, or use an OIDC read session with view:content-read authority.`
			});
			expect(requests).toStrictEqual([
				`${baseUrl.href}/reuse/reuse/api/v1/missing-paths`
			]);
		}
	);
	it.each([
		{ name: 'a separate view access key', viewKey: sourceAccessKey },
		{ name: 'no access key for the view', viewKey: undefined }
	])('sends $name without changing destination reads', async ({ viewKey }) => {
		const requests: ProbeRequest[] = [];
		const probes = tenantProbesFor({
			baseUrl,
			cache: { kind: 'named', name: cacheNameSchema.parse('builds') },
			view: 'reuse',
			credentials: basicCredentialForAccessKey(destinationAccessKey),
			...(viewKey !== undefined && {
				viewCredentials: basicCredentialForAccessKey(viewKey)
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
					authorization: accessKeyAuthorization(destinationAccessKey)
				},
				{
					url: `${baseUrl.href}/reuse/reuse/api/v1/missing-paths`,
					...(viewKey !== undefined && {
						authorization: accessKeyAuthorization(viewKey)
					})
				}
			]
		});
	});
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
			viewCredentials: basicCredentialForAccessKey(sourceAccessKey),
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
					authorization: accessKeyAuthorization(sourceAccessKey)
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
	const deadlines = new ManualDeadlineTimer(probeDeadlineMs);
	const stalled = Promise.withResolvers<undefined>();
	const probes = tenantProbesFor({
		baseUrl,
		cache: { kind: 'default' },
		fetcher: (_input, init) => {
			bodies.push(typeof init?.body === 'string' ? init.body : '');
			if (bodies.length === 1) {
				stalled.resolve(undefined);

				return stalledResponse(init?.signal);
			}
			return Promise.resolve(
				Response.json({ missingStorePathHashes: [missingHash] })
			);
		},
		probe: { deadlineTimer: deadlines.arm, random: () => 0 }
	});

	const pending = probes.destinationServed([appPath, missingPath]);
	await Promise.race([stalled.promise, pending]);
	deadlines.expireOnly();

	expect(await pending).toStrictEqual(new Set([appPath]));

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
