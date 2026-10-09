import { type CacheScope } from '@cupboard/nix-store/scalars';
import { expect, it, vi } from 'vitest';

import { audienceSchema } from '../audience.ts';
import { pushAuthorizationDetails } from '../auth/attenuate.ts';
import {
	CupboardHttpError,
	ReferenceSourceReadRefusedError
} from '../errors.ts';
import { pushClientFor } from '../push/push-client.ts';

import { referenceBuildPushClient } from './reference-client.ts';

const defaultCache: CacheScope = { kind: 'default' };
const tenantUrl = new URL('https://cache.example.workers.dev/t/acme');
const original = pushClientFor(tenantUrl, 'original', { cache: defaultCache });
const replacement = pushClientFor(tenantUrl, 'replacement', {
	cache: defaultCache
});
const authority = pushAuthorizationDetails({
	cache: defaultCache,
	attest: false
});
const options = {
	tenantUrl,
	cache: defaultCache,
	client: original,
	auth: {
		githubOidc: true,
		audience: audienceSchema.parse(tenantUrl),
		authorizationDetails: authority
	}
};

it.each([
	{
		source: `${tenantUrl}/cache/pr`,
		access: 'private' as const,
		extra: [
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache: { kind: 'named', name: 'pr' }
			}
		]
	},
	{
		source: `${tenantUrl}/reuse/prs`,
		access: 'private' as const,
		extra: [
			{ type: 'cupboard_view', actions: ['view:content-read'], view: 'prs' }
		]
	},
	{ source: `${tenantUrl}/reuse/prs`, access: 'public' as const, extra: [] },
	{ source: tenantUrl.href, access: 'private' as const, extra: [] }
])(
	'requests source authority only when needed: $source $access',
	async ({ source, access, extra }) => {
		const authenticate = vi.fn<
			typeof import('../auth/auth.ts').authenticateForPush
		>(() =>
			Promise.resolve({
				get: () => Promise.resolve('replacement'),
				refresh: () => Promise.resolve('replacement')
			})
		);
		const createClient = vi.fn<typeof pushClientFor>(() => replacement);
		const fetchAccess = vi.fn<(url: URL) => Promise<'private' | 'public'>>(() =>
			Promise.resolve(access)
		);
		const client = await referenceBuildPushClient(
			[new URL(source), new URL(source)],
			options,
			{ authenticate, createClient, fetchAccess }
		);
		expect({
			isReplacement: client === replacement,
			requested: authenticate.mock.calls.map(
				(call) => call[1].authorizationDetails
			),
			created: createClient.mock.calls.length,
			probed: fetchAccess.mock.calls.map((call) => call[0].href)
		}).toStrictEqual({
			isReplacement: extra.length > 0,
			requested: extra.length > 0 ? [[...authority, ...extra]] : [],
			created: extra.length > 0 ? 1 : 0,
			probed: source === tenantUrl.href ? [] : [source]
		});
	}
);

it('reports refused private-source read authority without dropping the grant', async () => {
	const source = new URL(`${tenantUrl}/reuse/prs`);
	const refusal = new CupboardHttpError(
		'POST',
		'/token',
		400,
		JSON.stringify({
			error: 'invalid_authorization_details',
			problem: 'not-permitted'
		})
	);
	const authenticate = vi.fn(() => Promise.reject(refusal));
	await expect(
		referenceBuildPushClient([source], options, {
			authenticate,
			fetchAccess: () => Promise.resolve('private')
		})
	).rejects.toStrictEqual(
		new ReferenceSourceReadRefusedError([source], { cause: refusal })
	);
	expect(authenticate).toHaveBeenCalledTimes(1);
});
