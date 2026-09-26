import { describe, expect, it } from 'vitest';

import { parseDeploymentConfig } from './config.ts';
import {
	deploymentUrlVariable,
	recordedDeploymentUrl,
	withDeploymentUrl
} from './deployment-url.ts';

const config = parseDeploymentConfig(
	`{ "name": "cupboard", "compatibility_date": "2026-05-15" }`,
	`{ "name": "cupboard-tenant", "compatibility_date": "2026-05-15" }`
);

describe('withDeploymentUrl', () => {
	it.each([
		{
			name: 'records the URL on the control Worker only',
			url: 'https://cache.example.com',
			control: { [deploymentUrlVariable]: 'https://cache.example.com' }
		},
		{ name: 'records nothing without a URL', url: undefined, control: {} }
	])('$name', ({ url, control }) => {
		const recorded = withDeploymentUrl(config, url);

		expect({
			control: recorded.control.vars,
			tenant: recorded.tenant.vars
		}).toStrictEqual({
			control: { ...config.control.vars, ...control },
			tenant: config.tenant.vars
		});
	});
});

describe('recordedDeploymentUrl', () => {
	it.each([
		{
			name: 'the recorded URL',
			bindings: [
				{ type: 'd1', name: 'CUPBOARD_DB', database_id: 'db-1' },
				{
					type: 'plain_text',
					name: deploymentUrlVariable,
					text: 'https://cache.example.com'
				}
			],
			url: 'https://cache.example.com/'
		},
		{
			name: 'nothing for a Worker from an earlier release',
			bindings: [{ type: 'plain_text', name: 'OTHER', text: 'x' }],
			url: undefined
		},
		{
			name: 'nothing for a value that is not an HTTP URL',
			bindings: [
				{ type: 'plain_text', name: deploymentUrlVariable, text: 'cache' }
			],
			url: undefined
		}
	])('reads $name', ({ bindings, url }) => {
		expect(recordedDeploymentUrl(bindings)?.href).toBe(url);
	});
});
