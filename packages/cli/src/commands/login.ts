import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import { createReporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin
} from '../auth/oidc-login.ts';
import { writeCachedToken } from '../auth/token-store.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client/client.ts';
import { openBrowser } from '../io/open-browser.ts';

interface LoginOptions {
	readonly oidcIssuer: string;
	readonly clientId: string;
	readonly headless?: boolean;
}

export function registerLoginCommand(program: Command): void {
	program
		.command('login')
		.description(
			'Authenticate as the owner via OIDC and cache an admin access token.'
		)
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--oidc-issuer <issuer>', 'OIDC issuer URL')
		.requiredOption(
			'--client-id <id>',
			'registered public OAuth client id (PKCE, no client secret)'
		)
		.option(
			'--headless',
			'use the device flow instead of opening a browser (for SSH/containers)'
		)
		.action(async (url: string, options: LoginOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			const idToken = await reporter.phase('Logging in', async (ctx) => {
				ctx.fact('issuer', options.oidcIssuer);
				const endpoints = await discoverOidcLogin(options.oidcIssuer);

				return options.headless === true
					? deviceLogin({
							endpoints,
							clientId: options.clientId,
							prompt: (verification) => {
								reporter.info(
									`Visit ${verification.verificationUri} and enter code ${verification.userCode}`
								);
							}
						})
					: loopbackLogin({
							endpoints,
							clientId: options.clientId,
							openBrowser: (target) => {
								openBrowser(target, reporter);
							}
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
