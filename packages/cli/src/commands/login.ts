import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import { createReporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	DeviceAuthorizationRequestError,
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin
} from '../auth/oidc-login.ts';
import { writeCachedToken } from '../auth/token-store.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import {
	cloudflareLoopback,
	cloudflareOauthClientId
} from '../deploy/cloudflare-oauth.ts';
import { cloudflareDashIssuer } from '../deploy/owner.ts';
import { CliError } from '../errors.ts';
import { openBrowser } from '../io/open-browser.ts';

interface LoginOptions {
	readonly oidcIssuer: string;
	readonly clientId: string;
	readonly headless?: boolean;
}

/** The issuer refused the device grant for cupboard's own OAuth client. */
export class DeviceGrantNotEnabledError extends CliError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'Cloudflare refused to start a device login for cupboard. Enable the ' +
				'device code grant type on the cupboard OAuth client, or log in ' +
				'from a machine with a browser.',
			options
		);
		this.name = 'DeviceGrantNotEnabledError';
	}
}

/**
 * Translate a refused device authorization into actionable guidance when the
 * built-in Cloudflare client is in use; other clients and errors pass through.
 */
export function mapDeviceLoginError(error: unknown, clientId: string): unknown {
	if (
		error instanceof DeviceAuthorizationRequestError &&
		clientId === cloudflareOauthClientId &&
		[400, 401, 403].includes(error.status)
	) {
		return new DeviceGrantNotEnabledError({ cause: error });
	}

	return error;
}

export function registerLoginCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('login')
		.description(
			'Authenticate as the owner via OIDC and cache an admin access token.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--oidc-issuer <issuer>', 'OIDC issuer URL', cloudflareDashIssuer)
		.option(
			'--client-id <id>',
			'registered public OAuth client id (PKCE, no client secret)',
			cloudflareOauthClientId
		)
		.option(
			'--headless',
			'use the device flow instead of opening a browser (for SSH/containers)'
		)
		.action(async (url: string, options: LoginOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, {
				signal: programOptions.signal
			});
			// cupboard's own client has exact-match registered redirect URLs, so
			// the loopback server must bind one of them; any other client keeps
			// the ephemeral-port default.
			const usesCupboardClient = options.clientId === cloudflareOauthClientId;

			const idToken = await reporter.phase('Logging in', async (ctx) => {
				ctx.fact('issuer', options.oidcIssuer);
				const endpoints = await discoverOidcLogin(
					options.oidcIssuer,
					fetch,
					programOptions.signal
				);

				if (options.headless === true) {
					try {
						return await deviceLogin({
							endpoints,
							clientId: options.clientId,
							prompt: (verification) => {
								reporter.info(
									`Visit ${verification.verificationUri} and enter code ${verification.userCode}`
								);
							},
							signal: programOptions.signal
						});
					} catch (error) {
						throw mapDeviceLoginError(error, options.clientId);
					}
				}

				return loopbackLogin({
					endpoints,
					clientId: options.clientId,
					openBrowser: (target) => {
						openBrowser(target, reporter);
					},
					loopback: usesCupboardClient ? cloudflareLoopback : undefined,
					signal: programOptions.signal
				});
			});

			const exchanged = await client.tokenExchange(
				idToken,
				subjectTokenTypeIdToken
			);
			await writeCachedToken(exchanged.access_token, url);

			reporter.result([
				{ label: 'Cache URL', value: url },
				{ label: 'Session', value: 'admin token cached' }
			]);
		});
}
