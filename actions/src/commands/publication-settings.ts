import { env } from 'node:process';

import { publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig } from '@cupboard/nix-store/nix-config';
import { type CacheScope } from '@cupboard/nix-store/scalars';
import {
	createGithubReporter,
	type Reporter,
	type ResultCell,
	ResultLink,
	ResultTable
} from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	describeResolvedCupboard,
	parseResolvedCupboard,
	type ResolvedCupboard,
	resolvedCupboardFile,
	resolvedCupboardPage
} from '../cupboard-resolution.ts';
import { MissingInputError, RetentionChoiceConflictError } from '../errors.ts';
import type { Environment } from '../inputs.ts';
import {
	isEnabled,
	provided,
	providedCacheSelection,
	providedChoice,
	providedUrl
} from '../options.ts';
import { type RootRetention, rootRetention } from '../root-retention.ts';
import { cacheUrlFor } from '../substituters.ts';

import { fetchCachePublicKeyAt } from './setup.ts';

export interface PublicationSettingsOptions {
	readonly url?: string;
	readonly cupboard?: string;
	readonly publish?: string;
	readonly cache?: string;
	readonly cacheAccessMode?: string;
	readonly rootPrefix?: string;
	readonly ttl?: string;
	readonly permanent?: string;
	readonly reuseView?: string;
	readonly trustedPublicKey?: string;
}

interface PublicationSettingsDependencies {
	readonly reporter?: Reporter;
	readonly fetch?: typeof fetch;
}

interface PublicationSettings {
	readonly url: URL;
	readonly cupboard: ResolvedCupboard;
	readonly publish: 'none' | 'outputs' | 'built' | 'closure';
	readonly cache: CacheScope;
	readonly cacheAccessMode: 'public' | 'private' | '';
	readonly rootPrefix: string;
	readonly retention: RootRetention;
	readonly reuseView: string;
	readonly trustedPublicKey: string;
}

export function registerPublicationSettingsCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('publication-settings')
		.description(
			'Print the resolved publication settings and add them to the job summary.'
		)
		.requiredOption('--url <url>', 'tenant URL to publish to')
		.requiredOption(
			'--cupboard <json>',
			'the release or source commit from resolve-cupboard'
		)
		.option(
			'--publish <scope>',
			'published paths: none, outputs, built or closure'
		)
		.option('--cache <name>', 'named destination cache')
		.option('--cache-access-mode <mode>', 'required access, public or private')
		.requiredOption(
			'--root-prefix <prefix>',
			"start of each target's root name"
		)
		.option('--ttl <ttl>', 'how long each root lasts after a run sets it')
		.option('--permanent <value>', 'keep each root permanently: true or false')
		.option('--reuse-view <name>', 'reuse view to read through')
		.option(
			'--trusted-public-key <key>',
			"the tenant's public key; downloaded from /pubkey when empty"
		)
		.action((options: PublicationSettingsOptions) =>
			publicationSettingsAction(options, environment)
		);
}

/**
 * Prints the publication settings and appends them to the job summary, with
 * the nix.conf lines that read the destination cache. When it cannot download
 * the tenant's public key, it warns and leaves the nix.conf lines out.
 */
export async function publicationSettingsAction(
	options: PublicationSettingsOptions,
	environment: Environment = env,
	dependencies: PublicationSettingsDependencies = {}
): Promise<void> {
	const settings = resolvePublicationSettings(options);
	const reporter =
		dependencies.reporter ?? createGithubReporter({ environment });
	const serverUrl = new URL(
		provided(environment.GITHUB_SERVER_URL) ?? 'https://github.com'
	);

	reporter.result({
		kind: 'publication-settings',
		title: 'Publication settings',
		data: settings,
		rows: [],
		table: settingsTable(settings, serverUrl),
		jobSummary: true
	});

	const publicKey = await trustedPublicKey(settings, reporter, dependencies);

	if (publicKey === undefined) {
		return;
	}

	reporter.result({
		kind: 'publication-nix-config',
		title: 'nix.conf lines for reading the cache',
		data: { publicKey },
		rows: [],
		code: new NixConfig(cacheUrlFor(settings.url, settings.cache), publicKey)
			.render()
			.trimEnd(),
		...(settings.cacheAccessMode === 'private' && {
			note: privateCacheNote(settings.cupboard, serverUrl)
		}),
		jobSummary: true
	});
}

function resolvePublicationSettings(
	options: PublicationSettingsOptions
): PublicationSettings {
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const cupboard = provided(options.cupboard);

	if (cupboard === undefined) {
		throw new MissingInputError('cupboard');
	}

	const rootPrefix = provided(options.rootPrefix);

	if (rootPrefix === undefined) {
		throw new MissingInputError('root-prefix');
	}

	const ttl = provided(options.ttl) ?? '';
	const isPermanent = isEnabled('permanent', options.permanent, false);

	if (ttl !== '' && isPermanent) {
		throw new RetentionChoiceConflictError('ttl', 'permanent');
	}

	return {
		url,
		cupboard: parseResolvedCupboard(cupboard),
		publish: providedChoice(
			'publish',
			options.publish,
			['none', 'outputs', 'built', 'closure'],
			'built'
		),
		cache: providedCacheSelection(options.cache),
		cacheAccessMode: providedChoice(
			'cache-access-mode',
			options.cacheAccessMode,
			['public', 'private', ''],
			''
		),
		rootPrefix,
		retention: rootRetention(ttl, isPermanent),
		reuseView: provided(options.reuseView) ?? '',
		trustedPublicKey: provided(options.trustedPublicKey) ?? ''
	};
}

function settingsTable(
	settings: PublicationSettings,
	serverUrl: URL
): ResultTable {
	const cupboard = new ResultLink(
		describeResolvedCupboard(settings.cupboard),
		resolvedCupboardPage(settings.cupboard, serverUrl)
	);

	return ResultTable.of(
		[
			{ key: 'setting', label: 'Setting' },
			{ key: 'value', label: 'Value' }
		],
		[
			{ setting: 'Cupboard', value: cupboard },
			{ setting: 'Publish', value: settings.publish },
			{
				setting: 'Cache',
				value:
					settings.cache.kind === 'named'
						? settings.cache.name
						: 'Default cache'
			},
			{
				setting: 'Cache access',
				value:
					settings.cacheAccessMode === ''
						? 'Existing, or the tenant default for a new cache'
						: settings.cacheAccessMode
			},
			{ setting: 'Root prefix', value: settings.rootPrefix },
			{ setting: 'Root retention', value: retentionText(settings.retention) },
			{
				setting: 'Reuse view',
				value: settings.reuseView === '' ? 'None' : settings.reuseView
			}
		]
	);
}

function privateCacheNote(
	cupboard: ResolvedCupboard,
	serverUrl: URL
): readonly ResultCell[] {
	const guide = resolvedCupboardFile(
		cupboard,
		serverUrl,
		'docs/use/private-caches.md#giving-credentials-to-nix'
	);

	return [
		'A private cache also needs a read credential, in a netrc entry or in the substituter URL. See ',
		new ResultLink('Giving credentials to Nix', guide),
		'.'
	];
}

function retentionText(retention: RootRetention): string {
	if (retention.kind === 'permanent') {
		return 'Permanent';
	}

	return retention.kind === 'ttl'
		? `${retention.ttl} after each run`
		: 'Cache retention setting';
}

async function trustedPublicKey(
	settings: PublicationSettings,
	reporter: Reporter,
	dependencies: PublicationSettingsDependencies
): Promise<string | undefined> {
	if (settings.trustedPublicKey !== '') {
		return settings.trustedPublicKey;
	}

	try {
		return await fetchCachePublicKeyAt(
			publicKeyUrl(settings.url),
			dependencies.fetch
		);
	} catch (error) {
		reporter.warn(
			'Leaving the nix.conf lines out of the job summary',
			error instanceof Error ? error.message : String(error)
		);

		return undefined;
	}
}
