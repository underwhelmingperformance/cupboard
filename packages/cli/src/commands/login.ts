import { spawn } from 'node:child_process';
import { platform } from 'node:process';

import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import {
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin
} from '../oidc-login.ts';
import { createReporter, type Reporter } from '../reporter.ts';
import { writeCachedToken } from '../token-store.ts';

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
			await writeCachedToken(exchanged.access_token);

			reporter.result([
				{ label: 'Cache URL', value: url },
				{ label: 'Session', value: 'admin token cached' }
			]);
		});
}

// Best-effort browser launch: the URL is always printed, so a failed or absent
// opener leaves the owner a link to follow rather than a dead end.
function openBrowser(target: string, reporter: Reporter): void {
	reporter.info(`Opening your browser to:\n${target}`);

	const launch = browserLaunch(platform, target);
	const child = spawn(launch.command, launch.args, {
		stdio: 'ignore',
		detached: true
	});
	child.on('error', () => {
		reporter.warn('Could not open a browser automatically');
	});
	child.unref();
}

function browserLaunch(
	os: NodeJS.Platform,
	target: string
): { readonly command: string; readonly args: readonly string[] } {
	if (os === 'darwin') {
		return { command: 'open', args: [target] };
	}

	if (os === 'win32') {
		return { command: 'cmd', args: ['/c', 'start', '', target] };
	}

	return { command: 'xdg-open', args: [target] };
}
