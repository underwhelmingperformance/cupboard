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
