import { cacheNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import { tenantProbesFor } from './destination-probe.ts';

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
		'refuses a cache-specific credential at a private view with advice: %s',
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
		{ name: 'the shared credential fallback', viewPassword: undefined }
	])(
		'uses $name without changing destination reads',
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
						authorization: `Basic ${btoa(`${viewPassword === undefined ? 'reader' : 'view-reader'}:${viewPassword ?? 'cache-secret'}`)}`
					}
				]
			});
		}
	);
});
