import { describe, expect, it } from 'vitest';

import {
	jobSummaryFile,
	recordingGithubReporter
} from '../reporter-testing.ts';

import {
	publicationSettingsAction,
	type PublicationSettingsOptions
} from './publication-settings.ts';

const releaseCupboard = JSON.stringify({
	kind: 'release',
	repository: 'underwhelmingperformance/cupboard',
	tag: 'vX.Y.Z',
	sourceCommit: 'a'.repeat(40)
});
const sourceCupboard = JSON.stringify({
	kind: 'source',
	repository: 'underwhelmingperformance/cupboard',
	sourceCommit: 'b'.repeat(40)
});
const publicKey =
	'cupboard-acme-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function settingsSummary(rows: readonly string[]): string {
	return [
		'### Publication settings',
		'',
		'| Setting | Value |',
		'| --- | --- |',
		...rows,
		'',
		''
	].join('\n');
}

const credentialsGuide =
	'https://github.com/underwhelmingperformance/cupboard/blob/vX.Y.Z/docs/use/private-caches.md#giving-credentials-to-nix';

function nixConfigSummary(
	cacheUrl: string,
	note: readonly string[] = []
): string {
	return [
		'### nix.conf lines for reading the cache',
		'',
		'```',
		`extra-substituters = ${cacheUrl}`,
		`extra-trusted-public-keys = ${publicKey}`,
		'```',
		'',
		...note.flatMap((line) => [line, '']),
		''
	].join('\n');
}

describe('publicationSettingsAction', () => {
	it.each([
		{
			name: 'a pull-request run that publishes to its own cache',
			options: {
				url: 'https://cupboard.example.workers.dev/acme',
				cupboard: releaseCupboard,
				publish: 'built',
				cache: 'gh-1234-pr-7',
				cacheAccessMode: 'private',
				rootPrefix: 'github:acme/app/pr-7',
				ttl: '14d',
				permanent: 'false',
				reuseView: '',
				trustedPublicKey: publicKey
			},
			requests: [],
			log: [
				'Publication settings',
				'Setting         Value',
				'Cupboard        release vX.Y.Z (https://github.com/underwhelmingperformance/cupboard/releases/tag/vX.Y.Z)',
				'Publish         built',
				'Cache           gh-1234-pr-7',
				'Cache access    private',
				'Root prefix     github:acme/app/pr-7',
				'Root retention  14d after each run',
				'Reuse view      None',
				'nix.conf lines for reading the cache',
				'extra-substituters = https://cupboard.example.workers.dev/acme/cache/gh-1234-pr-7',
				`extra-trusted-public-keys = ${publicKey}`,
				`A private cache also needs a read credential, in a netrc entry or in the substituter URL. See Giving credentials to Nix (${credentialsGuide}).`,
				''
			],
			summary: [
				settingsSummary([
					'| Cupboard | [release vX.Y.Z](<https://github.com/underwhelmingperformance/cupboard/releases/tag/vX.Y.Z>) |',
					'| Publish | built |',
					'| Cache | gh-1234-pr-7 |',
					'| Cache access | private |',
					'| Root prefix | github:acme/app/pr-7 |',
					'| Root retention | 14d after each run |',
					'| Reuse view | None |'
				]),
				nixConfigSummary(
					'https://cupboard.example.workers.dev/acme/cache/gh-1234-pr-7',
					[
						`A private cache also needs a read credential, in a netrc entry or in the substituter URL. See [Giving credentials to Nix](<${credentialsGuide}>).`
					]
				)
			]
		},
		{
			name: 'a branch run that reads through a reuse view',
			options: {
				url: 'https://cupboard.example.workers.dev/acme',
				cupboard: sourceCupboard,
				publish: 'built',
				cache: '',
				cacheAccessMode: '',
				rootPrefix: 'github:acme/app/main',
				ttl: '',
				permanent: 'true',
				reuseView: 'pull-requests-1234',
				trustedPublicKey: ''
			},
			requests: ['https://cupboard.example.workers.dev/acme/pubkey'],
			log: [
				'Publication settings',
				'Setting         Value',
				`Cupboard        built from source (https://github.com/underwhelmingperformance/cupboard/commit/${'b'.repeat(40)})`,
				'Publish         built',
				'Cache           Default cache',
				'Cache access    Existing, or the tenant default for a new cache',
				'Root prefix     github:acme/app/main',
				'Root retention  Permanent',
				'Reuse view      pull-requests-1234',
				'nix.conf lines for reading the cache',
				'extra-substituters = https://cupboard.example.workers.dev/acme',
				`extra-trusted-public-keys = ${publicKey}`,
				''
			],
			summary: [
				settingsSummary([
					`| Cupboard | [built from source](<https://github.com/underwhelmingperformance/cupboard/commit/${'b'.repeat(40)}>) |`,
					'| Publish | built |',
					'| Cache | Default cache |',
					'| Cache access | Existing, or the tenant default for a new cache |',
					'| Root prefix | github:acme/app/main |',
					'| Root retention | Permanent |',
					'| Reuse view | pull-requests-1234 |'
				]),
				nixConfigSummary('https://cupboard.example.workers.dev/acme')
			]
		},
		{
			name: 'a run whose roots follow the cache retention settings',
			options: {
				url: 'https://cupboard.example.workers.dev/acme',
				cupboard: releaseCupboard,
				publish: 'none',
				cache: '',
				cacheAccessMode: 'public',
				rootPrefix: 'release',
				ttl: '',
				permanent: 'false',
				reuseView: '',
				trustedPublicKey: publicKey
			},
			requests: [],
			log: [
				'Publication settings',
				'Setting         Value',
				'Cupboard        release vX.Y.Z (https://github.com/underwhelmingperformance/cupboard/releases/tag/vX.Y.Z)',
				'Publish         none',
				'Cache           Default cache',
				'Cache access    public',
				'Root prefix     release',
				'Root retention  Cache retention setting',
				'Reuse view      None',
				'nix.conf lines for reading the cache',
				'extra-substituters = https://cupboard.example.workers.dev/acme',
				`extra-trusted-public-keys = ${publicKey}`,
				''
			],
			summary: [
				settingsSummary([
					'| Cupboard | [release vX.Y.Z](<https://github.com/underwhelmingperformance/cupboard/releases/tag/vX.Y.Z>) |',
					'| Publish | none |',
					'| Cache | Default cache |',
					'| Cache access | public |',
					'| Root prefix | release |',
					'| Root retention | Cache retention setting |',
					'| Reuse view | None |'
				]),
				nixConfigSummary('https://cupboard.example.workers.dev/acme')
			]
		}
	] satisfies readonly {
		readonly name: string;
		readonly options: PublicationSettingsOptions;
		readonly requests: readonly string[];
		readonly log: readonly string[];
		readonly summary: readonly string[];
	}[])(
		'prints and summarises $name',
		async ({ options, requests, log, summary }) => {
			const recording = recordingGithubReporter();
			const requested: string[] = [];

			await publicationSettingsAction(
				options,
				{},
				{
					reporter: recording.reporter,
					fetch: (input) => {
						requested.push(
							input instanceof Request ? input.url : String(input)
						);

						return Promise.resolve(new Response(`${publicKey}\n`));
					}
				}
			);

			expect({
				requests: requested,
				log: recording.log().split('\n'),
				summary: recording.summary
			}).toStrictEqual({
				requests,
				log,
				summary: summary.map((text) => ({ path: jobSummaryFile, text }))
			});
		}
	);

	it('leaves out the nix.conf lines and warns when the public key is unavailable', async () => {
		const recording = recordingGithubReporter();

		await publicationSettingsAction(
			{
				url: 'https://cupboard.example.workers.dev/acme',
				cupboard: releaseCupboard,
				publish: 'built',
				cache: '',
				cacheAccessMode: '',
				rootPrefix: 'github:acme/app/main',
				ttl: '',
				permanent: 'true',
				reuseView: '',
				trustedPublicKey: ''
			},
			{},
			{
				reporter: recording.reporter,
				fetch: () => Promise.resolve(new Response('', { status: 404 }))
			}
		);

		expect({
			warnings: recording
				.log()
				.split('\n')
				.filter((line) => line.startsWith('::warning::')),
			summaryTitles: recording.summary.map(
				(entry) => entry.text.split('\n', 1)[0]
			)
		}).toStrictEqual({
			warnings: [
				expect.stringMatching(
					/^::warning::Leaving the nix\.conf lines out of the job summary: /u
				)
			],
			summaryTitles: ['### Publication settings']
		});
	});
});
