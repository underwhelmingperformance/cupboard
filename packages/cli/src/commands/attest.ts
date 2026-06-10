import { env } from 'node:process';

import { createReporter, formatCount } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	verifyLocalAttestations,
	verifyRemoteAttestations
} from '../attest/verify.ts';
import { reporterModeFromGlobals } from '../cli.ts';

interface VerifyOptions {
	readonly narHash?: string;
	readonly url?: string;
	readonly storePathHash?: string;
	readonly cache?: string;
	readonly bundleDigest?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly trustedPublicKey?: string;
	readonly trustCachePubkey?: boolean;
	readonly certificateIdentity?: string;
	readonly certificateIdentityRegex?: string;
	readonly certificateOidcIssuer?: string;
	readonly certificateOidcIssuerRegex?: string;
	readonly predicateType: string;
	readonly trustedRoot?: string;
	readonly tlogThreshold?: number;
	readonly ctlogThreshold?: number;
	readonly timestampThreshold?: number;
}

export class InvalidVerifierThresholdError extends Error {
	constructor(
		public readonly option: string,
		public readonly value: string
	) {
		super(`Invalid ${option} (expected a non-negative integer): ${value}`);
		this.name = 'InvalidVerifierThresholdError';
	}
}

export function parseVerifierThreshold(option: string) {
	return (value: string): number => {
		if (!/^\d+$/.test(value)) {
			throw new InvalidVerifierThresholdError(option, value);
		}

		const parsed = Number(value);

		if (!Number.isSafeInteger(parsed)) {
			throw new InvalidVerifierThresholdError(option, value);
		}

		return parsed;
	};
}

export function registerAttestCommands(program: Command): void {
	const attest = program
		.command('attest')
		.description('Work with filed Sigstore attestation bundles.');

	attest
		.command('verify')
		.description(
			'Verify filed Sigstore DSSE attestations against a Sigstore trust root and threshold policy.'
		)
		.argument('[bundles...]', 'local Sigstore bundle files')
		.option('--nar-hash <hash>', 'expected NAR hash for local bundle mode')
		.option('--url <url>', 'remote cupboard cache URL')
		.option('--store-path-hash <hash>', 'remote store-path hash to inspect')
		.option('--cache <name>', 'remote named cache')
		.option('--bundle-digest <digest>', 'remote bundle digest to verify')
		.option('--read-user <user>', 'private-read username')
		.option('--read-password <password>', 'private-read password')
		.option('--trusted-public-key <key>', 'trusted narinfo public key')
		.option(
			'--trust-cache-pubkey',
			'fetch /pubkey from the cache and use it as the narinfo trust source'
		)
		.requiredOption(
			'--predicate-type <type>',
			'required in-toto predicate type for each verified bundle'
		)
		.option(
			'--trusted-root <path>',
			'Sigstore trusted_root.json file; defaults to the public Sigstore root'
		)
		.option(
			'--tlog-threshold <count>',
			'minimum Rekor transparency-log entries required; default is Sigstore verifier policy',
			parseVerifierThreshold('--tlog-threshold')
		)
		.option(
			'--ctlog-threshold <count>',
			'minimum certificate-transparency log entries required; default is Sigstore verifier policy',
			parseVerifierThreshold('--ctlog-threshold')
		)
		.option(
			'--timestamp-threshold <count>',
			'minimum signed timestamps required; default is Sigstore verifier policy',
			parseVerifierThreshold('--timestamp-threshold')
		)
		.option('--certificate-identity <identity>', 'expected signing identity')
		.option(
			'--certificate-identity-regex <regex>',
			'regular expression for the signing identity'
		)
		.option(
			'--certificate-oidc-issuer <issuer>',
			'expected signing OIDC issuer'
		)
		.option(
			'--certificate-oidc-issuer-regex <regex>',
			'regular expression for the signing OIDC issuer'
		)
		.action(async (bundles: string[], options: VerifyOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const readUser = options.readUser ?? env.CUPBOARD_READ_USER;
			const readPassword = options.readPassword ?? env.CUPBOARD_READ_PASSWORD;
			const common = {
				certificateIdentity: options.certificateIdentity,
				certificateIdentityRegex: options.certificateIdentityRegex,
				certificateOidcIssuer: options.certificateOidcIssuer,
				certificateOidcIssuerRegex: options.certificateOidcIssuerRegex,
				predicateType: options.predicateType,
				trustedRoot: options.trustedRoot,
				tlogThreshold: options.tlogThreshold,
				ctlogThreshold: options.ctlogThreshold,
				timestampThreshold: options.timestampThreshold
			};

			const results = await reporter.phase('Verifying attestations', () => {
				if (options.url !== undefined || options.storePathHash !== undefined) {
					if (bundles.length > 0) {
						throw new Error('Remote verification does not take bundle paths');
					}

					if (
						options.url === undefined ||
						options.storePathHash === undefined
					) {
						throw new Error(
							'Remote verification requires --url and --store-path-hash'
						);
					}

					return verifyRemoteAttestations({
						...common,
						url: options.url,
						storePathHash: options.storePathHash,
						cache: options.cache,
						bundleDigest: options.bundleDigest,
						readUser,
						readPassword,
						trustedPublicKey: options.trustedPublicKey,
						trustCachePubkey: options.trustCachePubkey
					});
				}

				if (options.narHash === undefined) {
					throw new Error('Local verification requires --nar-hash');
				}

				if (bundles.length === 0) {
					throw new Error('Local verification requires at least one bundle');
				}

				return verifyLocalAttestations({
					...common,
					bundles,
					narHash: options.narHash
				});
			});

			reporter.result([
				{ label: 'Verified bundles', value: formatCount(results.length) },
				{
					label: 'Predicate types',
					value: formatCount(
						new Set(results.map((item) => item.predicateType)).size
					)
				}
			]);

			for (const result of results) {
				reporter.info(
					[
						result.bundle,
						result.predicateType,
						result.signerIdentity ?? '(unknown signer)'
					].join(' ')
				);
			}
		});
}
