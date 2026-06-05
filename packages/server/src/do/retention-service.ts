import {
	retentionPolicyAddBodySchema,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { parseRequestBody } from '../http/parse.ts';
import { mostSpecificPolicy } from '../policy/policy-match.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { policySummaryFromRow, type ServerContext } from './context.ts';

export class RetentionService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleListPolicies(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => policySummaryFromRow(row))
			.toSorted((left, right) => (left.id > right.id ? 1 : -1));

		return Response.json({ policies } satisfies RetentionPolicyListResponse);
	}

	async handleAddPolicy(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const body = await parseRequestBody(retentionPolicyAddBodySchema, request);
		const id = crypto.randomUUID();

		this.context.db
			.insert(schema.retentionPolicies)
			.values({
				id,
				scope: body.scope,
				pattern: body.pattern,
				defaultTtlSeconds: body.ttlSeconds,
				createdAt: new Date().toISOString()
			})
			.run();

		return Response.json({
			id,
			scope: body.scope,
			pattern: body.pattern,
			ttlSeconds: body.ttlSeconds
		} satisfies RetentionPolicySummary);
	}

	async handleRemovePolicy(request: Request, id: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const existing = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.get();

		this.context.db
			.delete(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.run();

		return Response.json({
			id,
			removed: existing !== undefined
		} satisfies RetentionPolicyRemoveResponse);
	}

	resolvePolicyTtl(cache: string, name: string): number | undefined {
		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => ({
				scope: row.scope,
				pattern: row.pattern,
				ttlSeconds: row.defaultTtlSeconds
			}));

		return mostSpecificPolicy(policies, { cache, name })?.ttlSeconds;
	}
}
