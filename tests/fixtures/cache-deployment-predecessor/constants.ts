export const predecessorVersionTag = '37bc799de0bc';
export const predecessorD1Migration = '0019_nar_read_authority.sql';
export const predecessorDurableObjectMigration =
	'0041_pending_upload_recorded_verdict';

export const fixtureTenants: readonly [
	'upgrade-active',
	'upgrade-suspended',
	'upgrade-offboarding',
	'upgrade-offboarded',
	'upgrade-sleeping-0022',
	'upgrade-sleeping-0024',
	'upgrade-sleeping-0031'
] = [
	'upgrade-active',
	'upgrade-suspended',
	'upgrade-offboarding',
	'upgrade-offboarded',
	'upgrade-sleeping-0022',
	'upgrade-sleeping-0024',
	'upgrade-sleeping-0031'
];

export const seededFixtureTenants: readonly [
	'upgrade-active',
	'upgrade-suspended',
	'upgrade-offboarding',
	'upgrade-sleeping-0022',
	'upgrade-sleeping-0024',
	'upgrade-sleeping-0031'
] = [
	'upgrade-active',
	'upgrade-suspended',
	'upgrade-offboarding',
	'upgrade-sleeping-0022',
	'upgrade-sleeping-0024',
	'upgrade-sleeping-0031'
];

export const sleepingFixtureTenants: readonly [
	'upgrade-sleeping-0022',
	'upgrade-sleeping-0024',
	'upgrade-sleeping-0031'
] = ['upgrade-sleeping-0022', 'upgrade-sleeping-0024', 'upgrade-sleeping-0031'];

export type FixtureTenant = (typeof fixtureTenants)[number];

const fixtureTenantValues: ReadonlySet<string> = new Set(fixtureTenants);

export function isFixtureTenant(value: string): value is FixtureTenant {
	return fixtureTenantValues.has(value);
}
