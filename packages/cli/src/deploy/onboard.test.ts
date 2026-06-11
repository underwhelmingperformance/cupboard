import { describe, expect, it } from 'vitest';

import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import { onboardDeployment, type OnboardOutcome } from './onboard.ts';
import type { DeployUi } from './ui.ts';

const unexpected = (member: string) => (): never => {
	throw new Error(`${member} was not expected`);
};

function quietUi(): DeployUi {
	const facts: string[] = [];

	return {
		intro: unexpected('intro'),
		outro: unexpected('outro'),
		cancelled: unexpected('cancelled'),
		info: unexpected('info'),
		success: unexpected('success'),
		warn: unexpected('warn'),
		note: unexpected('note'),
		menu: unexpected('menu'),
		editText: unexpected('editText'),
		secret: unexpected('secret'),
		chooseAccount: unexpected('chooseAccount'),
		openBrowser: unexpected('openBrowser'),
		reporter: () => ({
			phase: (_label, body) =>
				Promise.resolve(
					body({
						fact: (label, value) => {
							facts.push(`${label} ${String(value)}`);
						}
					})
				),
			result: unexpected('result'),
			warn: unexpected('reporter.warn'),
			info: unexpected('reporter.info')
		})
	};
}

const baseApi: CloudflareApi = {
	listAccounts: unexpected('listAccounts'),
	r2BucketExists: unexpected('r2BucketExists'),
	ensureR2Bucket: unexpected('ensureR2Bucket'),
	ensureD1Database: unexpected('ensureD1Database'),
	ensureKvNamespace: unexpected('ensureKvNamespace'),
	ensureQueue: unexpected('ensureQueue'),
	d1Query: unexpected('d1Query'),
	d1QueryRows: unexpected('d1QueryRows'),
	getScriptMigrationTag: unexpected('getScriptMigrationTag'),
	uploadScript: unexpected('uploadScript'),
	ensureQueueConsumer: unexpected('ensureQueueConsumer'),
	ensureSchedules: unexpected('ensureSchedules'),
	putSecret: unexpected('putSecret'),
	listScriptSecrets: unexpected('listScriptSecrets'),
	findZoneId: unexpected('findZoneId'),
	ensureCustomDomain: unexpected('ensureCustomDomain'),
	listTokenPermissionGroups: unexpected('listTokenPermissionGroups'),
	findApiTokenId: unexpected('findApiTokenId'),
	createApiToken: unexpected('createApiToken'),
	rollApiTokenSecret: unexpected('rollApiTokenSecret'),
	getWorkersDevSubdomain: unexpected('getWorkersDevSubdomain'),
	enableWorkersDevRoute: unexpected('enableWorkersDevRoute')
};

function apiWith(overrides: Partial<CloudflareApi>): { api: CloudflareApi } {
	return { api: { ...baseApi, ...overrides } };
}

/** A subdomain lookup; called with no argument it finds none registered. */
const subdomainOf = (value?: string) => (): Promise<string | undefined> =>
	Promise.resolve(value);

/** One scripted `/pubkey` answer: a key, an HTTP status, or no route at all. */
type ScriptedProbe = number | 'offline' | { readonly key: string };

function scriptedClient(probes: readonly ScriptedProbe[]): {
	publicKey: () => Promise<string>;
} {
	const remaining = [...probes];

	return {
		publicKey: () => {
			const next = remaining.shift();

			if (next === undefined) {
				throw new Error('publicKey probed more often than scripted');
			}

			if (next === 'offline') {
				return Promise.reject(new TypeError('fetch failed'));
			}

			if (typeof next === 'number') {
				return Promise.reject(
					new CupboardHttpError('GET', '/pubkey', next, 'not yet')
				);
			}

			return Promise.resolve(next.key);
		}
	};
}

describe('onboardDeployment', () => {
	it('uses the custom domain without touching workers.dev', async () => {
		const { api } = apiWith({});

		const outcome = await onboardDeployment({
			api,
			ui: quietUi(),
			controlScriptName: 'cupboard',
			domain: 'cache.example.com',
			clientFactory: (url) => {
				expect(url).toBe('https://cache.example.com');
				return scriptedClient([{ key: 'pk-1' }]);
			},
			sleep: () => Promise.resolve()
		});

		expect(outcome).toStrictEqual({
			kind: 'ready',
			url: 'https://cache.example.com',
			publicKey: 'pk-1'
		});
	});

	it('enables the workers.dev route and polls through routing delays', async () => {
		const enabled: string[] = [];
		const { api } = apiWith({
			getWorkersDevSubdomain: () => Promise.resolve('laney'),
			enableWorkersDevRoute: (scriptName) => {
				enabled.push(scriptName);
				return Promise.resolve();
			}
		});

		const outcome = await onboardDeployment({
			api,
			ui: quietUi(),
			controlScriptName: 'cupboard',
			domain: undefined,
			clientFactory: () =>
				scriptedClient(['offline', 404, 503, { key: 'pk-2' }]),
			sleep: () => Promise.resolve()
		});

		expect({ outcome, enabled }).toStrictEqual({
			outcome: {
				kind: 'ready',
				url: 'https://cupboard.laney.workers.dev',
				publicKey: 'pk-2'
			} satisfies OnboardOutcome,
			enabled: ['cupboard']
		});
	});

	it('reports a missing workers.dev subdomain', async () => {
		const { api } = apiWith({
			getWorkersDevSubdomain: subdomainOf()
		});

		expect(
			await onboardDeployment({
				api,
				ui: quietUi(),
				controlScriptName: 'cupboard',
				domain: undefined,
				clientFactory: unexpected('clientFactory'),
				sleep: () => Promise.resolve()
			})
		).toStrictEqual({ kind: 'no-subdomain' });
	});

	it('gives up after the attempts are exhausted', async () => {
		const { api } = apiWith({});

		expect(
			await onboardDeployment({
				api,
				ui: quietUi(),
				controlScriptName: 'cupboard',
				domain: 'cache.example.com',
				clientFactory: () => scriptedClient(['offline', 'offline', 'offline']),
				sleep: () => Promise.resolve(),
				attempts: 3
			})
		).toStrictEqual({
			kind: 'unreachable',
			url: 'https://cache.example.com',
			lastProbe: 'unreachable'
		});
	});

	it('propagates a genuine failure on the unauthenticated endpoint', async () => {
		const { api } = apiWith({});

		await expect(
			onboardDeployment({
				api,
				ui: quietUi(),
				controlScriptName: 'cupboard',
				domain: 'cache.example.com',
				clientFactory: () => scriptedClient([403]),
				sleep: () => Promise.resolve()
			})
		).rejects.toBeInstanceOf(CupboardHttpError);
	});
});
