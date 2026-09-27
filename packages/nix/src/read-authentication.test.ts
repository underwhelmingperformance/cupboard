import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withReadAuthentication } from './read-authentication.ts';

const tenantUrl = 'https://cupboard.example.workers.dev/t/acme';
const narinfo = `${tenantUrl}/cache/default/0123456789abcdfghijklmnpqrsvwxyz.narinfo`;

describe('withReadAuthentication', () => {
	it('rereads the wrapper credential for each request and preserves explicit authentication', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-action-read-')
		);
		const netrcFile = path.join(directory, 'netrc');
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			requests.push({
				url,
				authorization: headers.get('authorization') ?? undefined
			});

			return Promise.resolve(new Response());
		};
		const authenticated = withReadAuthentication(fetcher, {
			netrcFile,
			tenantUrl: new URL(tenantUrl)
		});

		try {
			await writeFile(
				netrcFile,
				'machine cupboard.example.workers.dev login cupboard-oidc password first\n'
			);
			await authenticated(narinfo);
			await writeFile(
				netrcFile,
				'machine cupboard.example.workers.dev login cupboard-oidc password second\n'
			);
			await authenticated(narinfo);
			await authenticated(narinfo, {
				headers: { authorization: 'Basic explicit' }
			});
			await authenticated(
				'https://cupboard.example.workers.dev/t/other/cache/default/nix-cache-info'
			);
			await authenticated('https://elsewhere.example/nix-cache-info');

			expect(requests).toStrictEqual([
				{
					url: narinfo,
					authorization: `Basic ${Buffer.from('cupboard-oidc:first').toString('base64')}`
				},
				{
					url: narinfo,
					authorization: `Basic ${Buffer.from('cupboard-oidc:second').toString('base64')}`
				},
				{ url: narinfo, authorization: 'Basic explicit' },
				{
					url: 'https://cupboard.example.workers.dev/t/other/cache/default/nix-cache-info',
					authorization: undefined
				},
				{
					url: 'https://elsewhere.example/nix-cache-info',
					authorization: undefined
				}
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('allows public reads when the effective Nix netrc does not exist', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-read-'));
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requests.push(input instanceof Request ? input.url : String(input));
			return Promise.resolve(new Response());
		};

		try {
			await withReadAuthentication(fetcher, {
				tenantUrl: new URL(tenantUrl),
				netrcFile: path.join(directory, 'missing')
			})(narinfo);
			expect(requests).toStrictEqual([narinfo]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('allows public reads when the effective Nix netrc is unreadable', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requests.push(input instanceof Request ? input.url : String(input));
			return Promise.resolve(new Response());
		};
		const authenticated = withReadAuthentication(fetcher, {
			tenantUrl: new URL(tenantUrl),
			netrcFile: '/unreadable/netrc',
			readFile: () =>
				Promise.reject(
					Object.assign(new Error('permission denied'), { code: 'EACCES' })
				)
		});

		await authenticated(narinfo);
		expect(requests).toStrictEqual([narinfo]);
	});
});
