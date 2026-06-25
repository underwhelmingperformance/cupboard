import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import type {
	S3CredentialCreated,
	S3CredentialListResponse,
	S3CredentialSummary
} from '@cupboard/protocol/s3-credentials';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	nixbuildSettingsLines,
	runS3CredentialCreate,
	runS3CredentialList,
	runS3CredentialRevoke,
	type S3CredentialClient
} from './s3-credential.ts';

const created: S3CredentialCreated = {
	credentialId: 'cred-1',
	accessKeyId: 'CBEXAMPLE',
	secretAccessKey: 'shhh',
	cache: '',
	label: 'nixbuild',
	writable: true
};

describe('runS3CredentialCreate', () => {
	it('passes the body, shows the secret once and skips nixbuild lines', async () => {
		const calls: Parameters<S3CredentialClient['create']>[0][] = [];
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runS3CredentialCreate(
			{ cache: '', label: 'nixbuild', writable: true },
			undefined,
			reporter(results, infos),
			{
				create(input) {
					calls.push(input);
					return Promise.resolve(created);
				}
			}
		);

		expect({ calls, results, infos }).toStrictEqual({
			calls: [{ cache: '', label: 'nixbuild', writable: true }],
			results: [
				[
					{ label: 'Credential', value: 'cred-1' },
					{ label: 'Access key id', value: 'CBEXAMPLE' },
					{ label: 'Secret access key', value: 'shhh' },
					{ label: 'Cache', value: '(default)' },
					{ label: 'Label', value: 'nixbuild' },
					{ label: 'Uploads', value: 'yes' }
				]
			],
			infos: ['The secret access key is shown only here; store it now.']
		});
	});

	it('emits the nixbuild settings when a target is given', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runS3CredentialCreate(
			{ cache: '', label: 'nixbuild', writable: true },
			{ endpoint: 'https://s3.example.com', bucket: 'acme', region: 'auto' },
			reporter(results, infos),
			{ create: () => Promise.resolve(created) }
		);

		expect(infos).toStrictEqual([
			'The secret access key is shown only here; store it now.',
			[
				'# Configure nixbuild.net to push to this cache:',
				"settings caches --add 's3://acme?region=auto&endpoint=https://s3.example.com&addressing-style=path'",
				"settings access-tokens --add 's3://acme=CBEXAMPLE:shhh'"
			].join('\n')
		]);
	});
});

describe('runS3CredentialList', () => {
	it('reports a row per credential', async () => {
		const results: ResultRow[][] = [];
		const summaries: S3CredentialSummary[] = [
			{
				credentialId: 'cred-1',
				accessKeyId: 'CBONE',
				cache: '',
				label: 'nixbuild',
				writable: true,
				createdAt: '2026-01-02T03:04:05.000Z'
			},
			{
				credentialId: 'cred-2',
				accessKeyId: 'CBTWO',
				cache: 'builds',
				label: 'mirror',
				writable: false,
				createdAt: '2026-01-02T03:04:05.000Z',
				expiresAt: '2026-06-01T00:00:00.000Z'
			}
		];
		const response: S3CredentialListResponse = { credentials: summaries };

		await runS3CredentialList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'CBONE',
					value: '(default); nixbuild; writable; created 2026-01-02 03:04 UTC'
				},
				{
					label: 'CBTWO',
					value:
						'builds; mirror; read-only; created 2026-01-02 03:04 UTC; expires 2026-06-01 00:00 UTC'
				}
			]
		]);
	});

	it('reports nothing when there are no credentials', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runS3CredentialList(reporter(results, infos), {
			list: () => Promise.resolve({ credentials: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No S3 credentials.']
		});
	});
});

describe('runS3CredentialRevoke', () => {
	it('revokes the credential once confirmed', async () => {
		const calls: string[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runS3CredentialRevoke('CBONE', ui, {
			revoke({ accessKeyId }) {
				calls.push(accessKeyId);
				return Promise.resolve({ revoked: true });
			}
		});

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: ['CBONE'],
			results: [
				{
					kind: 's3-credential',
					data: { revoked: true },
					rows: [
						{ label: 'Access key id', value: 'CBONE' },
						{ label: 'Revoked', value: 'yes' }
					]
				}
			]
		});
	});

	it('leaves the credential in place when declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });
		const calls: string[] = [];

		await runS3CredentialRevoke('CBONE', ui, {
			revoke({ accessKeyId }) {
				calls.push(accessKeyId);
				return Promise.resolve({ revoked: true });
			}
		});

		expect({
			calls,
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			calls: [],
			results: [],
			cancellations: ['The credential was left in place.']
		});
	});
});

describe('nixbuildSettingsLines', () => {
	const target = {
		endpoint: 'https://s3.example.com',
		bucket: 'acme',
		region: 'auto'
	};

	it.each([
		{
			name: 'the default cache omits the prefix',
			cache: '',
			bucketUrl: 's3://acme'
		},
		{
			name: 'a named cache becomes the prefix',
			cache: 'builds',
			bucketUrl: 's3://acme/builds'
		}
	])('$name', ({ cache, bucketUrl }) => {
		const lines = nixbuildSettingsLines(target, {
			accessKeyId: 'CBONE',
			secretAccessKey: 'shhh',
			cache
		});

		expect(lines).toStrictEqual([
			`settings caches --add '${bucketUrl}?region=auto&endpoint=https://s3.example.com&addressing-style=path'`,
			`settings access-tokens --add '${bucketUrl}=CBONE:shhh'`
		]);
	});
});
