import { describe, expect, it } from 'vitest';

import { mulhi, splitmix64, writeMurmur64 } from './arithmetic.ts';

describe('binary fuse arithmetic', () => {
	it.each([
		{ high: 0, low: 0, range: 1, expected: 0 },
		{ high: 0, low: 1, range: 0xff_ff_ff_ff, expected: 0 },
		{
			high: 0xff_ff_ff_ff,
			low: 0xff_ff_ff_ff,
			range: 0xff_ff_ff_ff,
			expected: 0xff_ff_ff_fe
		},
		{
			high: 0x80_00_00_00,
			low: 0,
			range: 0x80_00_00_00,
			expected: 0x40_00_00_00
		},
		{
			high: 0x12_34_56_78,
			low: 0x9a_bc_de_f0,
			range: 0x00_01_00_01,
			expected: 0x00_00_12_34
		},
		{
			high: 0xfe_dc_ba_98,
			low: 0x76_54_32_10,
			range: 0x13_57_9b_df,
			expected: 0x13_41_9a_0a
		}
	])(
		'matches the BigInt mulhi reference for $high:$low over $range',
		({ high, low, range, expected }) => {
			expect(mulhi(high, low, range)).toBe(expected);
		}
	);

	it.each([
		{ high: 0, low: 0, expected: { high: 0, low: 0 } },
		{
			high: 0,
			low: 1,
			expected: { high: 0xb4_56_bc_fc, low: 0x34_c2_cb_2c }
		},
		{
			high: 0xff_ff_ff_ff,
			low: 0xff_ff_ff_ff,
			expected: { high: 0x64_b5_72_0b, low: 0x4b_82_5f_21 }
		},
		{
			high: 0x80_00_00_00,
			low: 0,
			expected: { high: 0x8f_78_08_10, low: 0xaf_31_a4_93 }
		},
		{
			high: 0x12_34_56_78,
			low: 0x9a_bc_de_f0,
			expected: { high: 0x18_b8_c0_62, low: 0xf6_f4_23_98 }
		},
		{
			high: 0xfe_dc_ba_98,
			low: 0x76_54_32_10,
			expected: { high: 0x03_eb_eb_cc, low: 0x1f_4a_6f_d7 }
		}
	])(
		'matches the BigInt Murmur finaliser reference for $high:$low',
		({ high, low, expected }) => {
			const highs = new Uint32Array(1);
			const lows = new Uint32Array(1);

			writeMurmur64(highs, lows, 0, high, low);

			expect({ high: highs[0], low: lows[0] }).toStrictEqual(expected);
		}
	);

	it.each([
		{
			high: 0,
			low: 0,
			expected: {
				high: 0xe2_20_a8_39,
				low: 0x7b_1d_cd_af,
				nextHigh: 0x9e_37_79_b9,
				nextLow: 0x7f_4a_7c_15
			}
		},
		{
			high: 0,
			low: 1,
			expected: {
				high: 0x91_0a_2d_ec,
				low: 0x89_02_5c_c1,
				nextHigh: 0x9e_37_79_b9,
				nextLow: 0x7f_4a_7c_16
			}
		},
		{
			high: 0xff_ff_ff_ff,
			low: 0xff_ff_ff_ff,
			expected: {
				high: 0xe4_d9_71_77,
				low: 0x1b_65_2c_20,
				nextHigh: 0x9e_37_79_b9,
				nextLow: 0x7f_4a_7c_14
			}
		},
		{
			high: 0x80_00_00_00,
			low: 0,
			expected: {
				high: 0x48_1e_c0_a2,
				low: 0x12_a9_f3_db,
				nextHigh: 0x1e_37_79_b9,
				nextLow: 0x7f_4a_7c_15
			}
		},
		{
			high: 0x12_34_56_78,
			low: 0x9a_bc_de_f0,
			expected: {
				high: 0x16_19_22_c6,
				low: 0x45_ce_50_e8,
				nextHigh: 0xb0_6b_d0_32,
				nextLow: 0x1a_07_5b_05
			}
		},
		{
			high: 0xfe_dc_ba_98,
			low: 0x76_54_32_10,
			expected: {
				high: 0x7a_e8_93_b5,
				low: 0xe3_2f_ee_86,
				nextHigh: 0x9d_14_34_51,
				nextLow: 0xf5_9e_ae_25
			}
		}
	])(
		'matches the BigInt SplitMix64 reference for $high:$low',
		({ high, low, expected }) => {
			expect(splitmix64(high, low)).toStrictEqual(expected);
		}
	);
});
