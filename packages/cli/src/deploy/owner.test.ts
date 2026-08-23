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
				CUPBOARD_SIGNUP_ISSUER: 'https://accounts.example.com',
				CUPBOARD_SIGNUP_SUBJECT: 'user-7',
				CUPBOARD_SIGNUP_AUDIENCE: 'client-9'
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
				CUPBOARD_SIGNUP_ISSUER: '',
				CUPBOARD_SIGNUP_SUBJECT: '',
				CUPBOARD_SIGNUP_AUDIENCE: ''
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

	it('is ownerless when no owner is configured and no deployer is known', () => {
		const config = parseDeploymentConfig(configWithVariables({}), tenantSource);

		expect(defaultOwnerChoice(config)).toStrictEqual({
			kind: 'none'
		});
	});

	it('treats a partially configured owner as unconfigured', () => {
		const config = parseDeploymentConfig(
			configWithVariables({
				CUPBOARD_SIGNUP_ISSUER: 'https://accounts.example.com',
				CUPBOARD_SIGNUP_SUBJECT: '',
				CUPBOARD_SIGNUP_AUDIENCE: 'client-9'
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

	it('spells out the consequence of no admin', () => {
		expect(ownerHint({ kind: 'none' })).toBe('(none: nobody can claim admin)');
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
		['not a url', 'not-url'],
		['http://accounts.example.com', 'not-https'],
		['https://issuer.example.com/?x=1', 'not-bare-url']
	])('rejects %s', (value, problem) => {
		expect(ownerIssuerProblem(value)).toBe(problem);
	});
});

describe('ownerFieldProblem', () => {
	it('accepts a plain identifier', () => {
		expect(ownerFieldProblem('user-7')).toBeUndefined();
	});

	it.each([
		['', 'empty'],
		['  ', 'empty'],
		['two words', 'whitespace']
	])('rejects %j', (value, problem) => {
		expect(ownerFieldProblem(value)).toBe(problem);
	});
});
