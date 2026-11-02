import { StatusCodes } from 'http-status-codes';
import { beforeEach, expect, it } from 'vitest';

import {
	adminGrants,
	currentOrigin,
	currentServer,
	issueServerSignedToken,
	resetTestServer
} from '../test-support.ts';

const result = {
	storePath: `/nix/store/${'0'.repeat(32)}-result`,
	narHash: `sha256:${'0'.repeat(52)}`,
	generation: 0
};
const requestId = '11111111-1111-4111-8111-111111111111';
const members = Array.from({ length: 65 }, (_value, index) => ({
	storePath: `/nix/store/${index.toString(2).padStart(32, '0')}-member`,
	narHash: result.narHash
}));
const cases = [
	{
		path: '/lookup',
		method: 'POST',
		body: {
			source: { cache: { kind: 'default' } },
			results: members.map(({ storePath }) => ({ storePath }))
		},
		data: { limit: 'lookup-results', maximum: 64 }
	},
	{
		path: '/captures',
		method: 'POST',
		body: {
			result,
			expectedCacheGeneration: 1,
			requestId,
			origin: 'build-selection',
			memberCount: 100_001
		},
		data: { limit: 'total-members', maximum: 100_000 }
	},
	{
		path: `/captures/${requestId}/pages/0`,
		method: 'PUT',
		body: { members },
		data: { limit: 'page-members', maximum: 64 }
	}
];

beforeEach(resetTestServer);

it.each(
	['', '/cache/builds'].flatMap((prefix) =>
		cases.map((testCase) => ({ prefix, ...testCase }))
	)
)(
	'returns the declared $data.limit error for $prefix $path',
	async ({ prefix, path, method, body, data }) => {
		const token = await issueServerSignedToken(adminGrants());
		const response = await currentServer().fetch(
			new Request(`${currentOrigin()}${prefix}/publication-results${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify(body)
			})
		);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control'),
			body: await response.json()
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			cacheControl: 'no-store',
			body: {
				defined: true,
				code: 'PUBLICATION_LIMIT_EXCEEDED',
				status: StatusCodes.REQUEST_TOO_LONG,
				message: 'Publication request exceeds its declared limit',
				data
			}
		});
	}
);
