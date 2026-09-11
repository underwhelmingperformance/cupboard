/**
 * Platform figures the request caps in this package are sized against.
 *
 * A cap that keeps one invocation's work under a runtime ceiling is only as
 * good as the ceiling it was written for, so the figure belongs in one place
 * that both the caps and the Worker configuration can be checked against.
 */

/**
 * The calls to internal services one invocation may make: every R2 call, every
 * D1 call and every call to another Worker. Cloudflare's limits table counts
 * these apart from subrequests to the public internet, and on a paid plan the
 * internal figure follows the configured limit.
 *
 * Cloudflare's default for a paid account is this number, configurable up to
 * ten million. Both Worker configurations pin `limits.subrequests` rather than
 * taking the default, because the default has moved once already: it was 1,000
 * until February 2026, and several caps in this package were sized against
 * that figure. If a configuration inherits the default, nothing records which
 * ceiling the caps were sized against.
 *
 * `scripts/subrequest-budget.test.ts` holds the pin and this constant equal.
 * `packages/server/src/do/subrequest-budget.test.ts` checks that each capped
 * request's fan-out fits within it. Neither test is the runtime: a `limits`
 * block takes effect only on deployment, and the local pool enforces no
 * subrequest ceiling at all.
 */
export const subrequestsPerInvocation = 10_000;

/**
 * The D1 statements one invocation may run, counting each statement of a batch,
 * on each Workers plan. Cloudflare's D1 limits table gives these as "Queries per
 * Worker invocation".
 *
 * Unlike `subrequestsPerInvocation` this figure is not configurable. The plan
 * decides it, so a deployment supplies the figure its own plan allows and the
 * caps sized against it are functions of that value. A deployment that supplies
 * nothing gets the free figure: a pass that exhausts its allowance defers the
 * rest of its work and resumes, whereas a pass that assumes more than the plan
 * allows fails a statement at runtime.
 */
export const freeTierD1StatementsPerInvocation = 50;
export const paidTierD1StatementsPerInvocation = 1000;
