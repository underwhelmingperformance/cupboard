import { describe, expect, it } from 'vitest';

import { cloudflareOauthClientId } from './cloudflare-oauth.ts';
import { parseDeploymentConfig } from './config.ts';
import {
	cloudflareDashIssuer,
	defaultOwnerChoice,
	deployerOwner,
	ownerFieldProblem,
	ownerHint,
	ownerIssuerProblem
} from './owner.ts';

function configWithVariables(variables: Record<string, string>): string {
	return JSON.stringify({
		name: 'cupboard',
		compatibility_date: '2026-05-15',
		vars: variables
	});
}

const tenantSource = JSON.stringify({
	name: 'cupboard-tenant',
	compatibility_date: '2026-05-15'
});

describe('defaultOwnerChoice', () => {
	it('prefers an owner already configured in the wrangler vars', () => {
		const config = parseDeploymentConfig(
			configWithVariables({
				CUPBOARD_OWNER_ISSUER: 'https://accounts.example.com',
				CUPBOARD_OWNER_SUBJECT: 'user-7',
				CUPBOARD_OWNER_AUDIENCE: 'client-9'
			}),
			tenantSource
		);

		expect(defaultOwnerChoice(config, 'cf-user-1')).toStrictEqual({
			kind: 'owner',
			owner: {
				issuer: 'https://accounts.example.com',
				subject: 'user-7',
				audience: 'client-9'
			},
			origin: 'config'
		});
	});

	it('binds the deployer when the vars are empty and an identity is known', () => {
		const config = parseDeploymentConfig(
			configWithVariables({
				CUPBOARD_OWNER_ISSUER: '',
				CUPBOARD_OWNER_SUBJECT: '',
				CUPBOARD_OWNER_AUDIENCE: ''
			}),
			tenantSource
		);

		expect(defaultOwnerChoice(config, 'cf-user-1')).toStrictEqual({
			kind: 'owner',
			owner: {
				issuer: cloudflareDashIssuer,
				subject: 'cf-user-1',
				audience: cloudflareOauthClientId
			},
			origin: 'deployer'
		});
	});

	it('is ownerless when nothing is configured and nobody is known', () => {
		const config = parseDeploymentConfig(configWithVariables({}), tenantSource);

		expect(defaultOwnerChoice(config)).toStrictEqual({
			kind: 'none'
		});
	});

	it('treats a partially configured owner as unconfigured', () => {
		const config = parseDeploymentConfig(
			configWithVariables({
				CUPBOARD_OWNER_ISSUER: 'https://accounts.example.com',
				CUPBOARD_OWNER_SUBJECT: '',
				CUPBOARD_OWNER_AUDIENCE: 'client-9'
			}),
			tenantSource
		);

		expect(defaultOwnerChoice(config)).toStrictEqual({
			kind: 'none'
		});
	});
});

describe('ownerHint', () => {
	it('shows the issuer host, subject and origin', () => {
		expect(
			ownerHint({
				kind: 'owner',
				owner: deployerOwner('cf-user-1'),
				origin: 'deployer'
			})
		).toBe('dash.cloudflare.com · cf-user-1 (you, the deployer)');
	});

	it('spells out the consequence of no owner', () => {
		expect(ownerHint({ kind: 'none' })).toBe('(none: no admin login)');
	});
});

describe('ownerIssuerProblem', () => {
	it.each([['https://accounts.example.com'], ['https://dash.cloudflare.com']])(
		'accepts %s',
		(value) => {
			expect(ownerIssuerProblem(value)).toBeUndefined();
		}
	);

	it.each([
		['not a url', 'must be a URL'],
		['http://accounts.example.com', 'must use https'],
		['https://issuer.example.com/?x=1', 'without query or fragment']
	])('rejects %s', (value, reason) => {
		expect(ownerIssuerProblem(value)).toContain(reason);
	});
});

describe('ownerFieldProblem', () => {
	it('accepts a plain identifier', () => {
		expect(ownerFieldProblem('user-7')).toBeUndefined();
	});

	it.each([
		['', 'a value is required'],
		['  ', 'a value is required'],
		['two words', 'must not contain whitespace']
	])('rejects %j', (value, reason) => {
		expect(ownerFieldProblem(value)).toContain(reason);
	});
});
