import { setTimeout as delay } from 'node:timers/promises';

import { CupboardClient } from '../client/client.ts';
import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { DeployUi } from './ui.ts';

/** What a single `/pubkey` probe concluded. */
type Probe =
	| { readonly kind: 'ready'; readonly publicKey: string }
	| { readonly kind: 'retry'; readonly detail: string };

export type OnboardOutcome =
	| { readonly kind: 'ready'; readonly url: string; readonly publicKey: string }
	| { readonly kind: 'unreachable'; readonly url: string }
	| { readonly kind: 'no-subdomain' };

export interface OnboardOptions {
	readonly api: CloudflareApi;
	readonly ui: DeployUi;
	/** The control Worker's script name, which serves the cache. */
	readonly controlScriptName: string;
	readonly domain: string | undefined;
	readonly clientFactory?: (url: string) => Pick<CupboardClient, 'publicKey'>;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly attempts?: number;
}

const defaultAttempts = 30;
const attemptDelayMs = 4000;

/**
 * Turns a deployed Worker into a usable cache: resolves its URL (the custom
 * domain, or the account's workers.dev subdomain with the script's route
 * enabled), then polls `/pubkey`, whose first success creates the signing key.
 * Routing and DNS take time to settle, so not-yet-routable answers are
 * retried; an authentication failure on the unauthenticated endpoint is
 * genuine and propagates.
 */
export async function onboardDeployment(
	options: OnboardOptions
): Promise<OnboardOutcome> {
	const { ui } = options;
	const clientFactory =
		options.clientFactory ?? ((url: string) => CupboardClient.fromUrl(url));
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const attempts = options.attempts ?? defaultAttempts;

	let url: string;

	if (options.domain === undefined) {
		const subdomain = await options.api.getWorkersDevSubdomain();

		if (subdomain === undefined) {
			return { kind: 'no-subdomain' };
		}

		// With a custom domain the workers.dev route stays off: a private cache
		// gains nothing from a second public hostname.
		await ui
			.reporter()
			.phase('Enabling the workers.dev route', () =>
				options.api.enableWorkersDevRoute(options.controlScriptName)
			);

		url = `https://${options.controlScriptName}.${subdomain}.workers.dev`;
	} else {
		url = `https://${options.domain}`;
	}

	const client = clientFactory(url);
	let ready: string | undefined;

	await ui.reporter().phase('Initialising the cache', async (context) => {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			const probe = await probePublicKey(client);

			if (probe.kind === 'ready') {
				ready = probe.publicKey;
				return;
			}

			if (attempt < attempts) {
				context.fact('waiting for the Worker to come online, attempt', attempt);
				await sleep(attemptDelayMs);
			}
		}
	});

	return ready === undefined
		? { kind: 'unreachable', url }
		: { kind: 'ready', url, publicKey: ready };
}

async function probePublicKey(
	client: Pick<CupboardClient, 'publicKey'>
): Promise<Probe> {
	try {
		return { kind: 'ready', publicKey: await client.publicKey() };
	} catch (error) {
		if (error instanceof CupboardHttpError) {
			if (retryableStatus(error.status)) {
				return { kind: 'retry', detail: `HTTP ${String(error.status)}` };
			}

			throw error;
		}

		// fetch throws TypeError while DNS or routing has not settled yet.
		if (error instanceof TypeError) {
			return { kind: 'retry', detail: 'unreachable' };
		}

		throw error;
	}
}

function retryableStatus(status: number): boolean {
	return status === 404 || status === 408 || status === 429 || status >= 500;
}
