import {
	cacheDeploymentManifest,
	d1MigrationId,
	durableObjectMigrationId
} from '@cupboard/protocol/cache-deployment-manifest';
import type { ForwardDeploymentTransition } from '@cupboard/protocol/deployment-manifest';

export const deploymentManifest = cacheDeploymentManifest({
	d1: [
		{
			id: d1MigrationId('0000_blob_state.sql'),
			sha256: 'cf627e42722db1b5a5cdb2cfc889d0fa97fab236c322e7b681203b79de3431ab'
		},
		{
			id: d1MigrationId('0001_blob_ref_tenant_blob.sql'),
			sha256: '97dfbe32faf10b77be03405147c2e05e1fa54f0edd3949151342c01956409f2c'
		},
		{
			id: d1MigrationId('0002_blob_state_delete_after.sql'),
			sha256: '71eaffd40b70e48a2f9041a56ddd28b700d0d0e0e4c96eb37a0b998ac02be346'
		},
		{
			id: d1MigrationId('0003_control_auth_key.sql'),
			sha256: '0afa5c5642719f3a84b2e73176df2b08b9c127ddc2822645ea0289f03a38bfce'
		},
		{
			id: d1MigrationId('0004_control_trust.sql'),
			sha256: '5c051a0c4cff48e9f635b54152d991a51bdf398ee5b73c25cd4413c4515558e3'
		},
		{
			id: d1MigrationId('0005_tenant_registry.sql'),
			sha256: 'bfcb6830b45031409724d2c4d63641c845676cc2e56a86e961cf665b0d131520'
		},
		{
			id: d1MigrationId('0006_manifest_state.sql'),
			sha256: 'e47f7e79b11e5e6fb24c6a9e6bb0f314448f4a0c2744b36513339fa49ff8d2ed'
		},
		{
			id: d1MigrationId('0007_tenant_read_verifier.sql'),
			sha256: '3ee6a546f493501b4a6e8829e361163c3dbaa33dd25a428c5a3aeb676cb9ce25'
		},
		{
			id: d1MigrationId('0008_tenant_usage.sql'),
			sha256: '02c4b2aa7022884f8419a822642ff306ec539e416d293aca9c3970beb04b97d6'
		},
		{
			id: d1MigrationId('0009_tenant_last_maintained.sql'),
			sha256: 'db42612c8b4b29ff6f9ceffb63b9cc1ed5a32c3100e06895e1a07f6dcf387982'
		},
		{
			id: d1MigrationId('0010_next_pepper_potts.sql'),
			sha256: '49c0fccd4d1b94a81e686129715af2b59ac6624e6b48fa3e1efcf7de91c609f0'
		},
		{
			id: d1MigrationId('0011_concerned_winter_soldier.sql'),
			sha256: '7498cb25efc5fd42660f7ccad03bd33d0b966a25d19afcef8ec7f955ba490a10'
		},
		{
			id: d1MigrationId('0012_spicy_may_parker.sql'),
			sha256: '1142fd189458b686e440ba7775f2eb792e7a68cbbfa0df6b0c2af649a873fd0a'
		},
		{
			id: d1MigrationId('0013_common_mac_gargan.sql'),
			sha256: 'f7f7f57f4cac7b50af537c5859973722f2247431010743726f34d19a9c9ca1b5'
		},
		{
			id: d1MigrationId('0014_reshape_eligibility_projection.sql'),
			sha256: 'df50fd088620f43f8b000ae0a56244a723d73264e0afc99d5435e3bd470177c0'
		},
		{
			id: d1MigrationId('0015_lying_thor_girl.sql'),
			sha256: '8dfaf1701cb55c3011ce040a865204e70592089c0754471b6aeb21c2b13cd768'
		},
		{
			id: d1MigrationId('0016_global_admin_audience.sql'),
			sha256: '8a8cc15419f0fd7bc2670861a60ab7d03eceb347e8153234987ae851fd566ba4'
		},
		{
			id: d1MigrationId('0017_object_incarnations.sql'),
			sha256: '0317d139004a468f3a6abda302787724dd5e7ae01a290542bd25336f41ff4ad4'
		},
		{
			id: d1MigrationId('0018_tenant_cache_read_credential.sql'),
			sha256: '0f31406124a01766f9e663d00e53ea5217142d7e15da49f8e7b74547abd0bb9e'
		},
		{
			id: d1MigrationId('0019_nar_read_authority.sql'),
			sha256: '221ae52fc86187e04ee2e11b4d8e4833ceaaf27cda50ae356fb1503c49c902d0'
		},
		{
			id: d1MigrationId('0020_deployment_ledger.sql'),
			sha256: '36adbb826f555f703fb8d440158e75f6e181b6dbe2ad7f1aa59fdaf52e873b42'
		},
		{
			id: d1MigrationId('0020a_deployment_runtime_controls.sql'),
			sha256: '13faf6eb5864741a502bd18f1e099c71ed4e87b61835c5d024e243a566fbedad'
		},
		{
			id: d1MigrationId('0021_cache_access_expand.sql'),
			sha256: 'd0fe3330278ab01daeba8016a7cdbc3e06f4b0f80f9f63c7ca147ebd56ea6f38'
		},
		{
			id: d1MigrationId('0022_cache_access_legacy_write_mirror.sql'),
			sha256: 'a02ca2a5cf79714adb5249bae3728ad0dcc3cf5a5eed6144960c1fbc3376bc02'
		},
		{
			id: d1MigrationId('0023_cache_access_backfill.sql'),
			sha256: 'c2c28c5317e140ea9759544dbc7f171e88d163195ee1e0b19aac5fa256768c45'
		},
		{
			id: d1MigrationId('0024_cache_access_contract_assertions.sql'),
			sha256: '27e89e579a506064a633ae99911b875b4c3df766afb2f8807be114f9f1c786e3'
		},
		{
			id: d1MigrationId('0025_cache_access_compatible_contract.sql'),
			sha256: 'f70a33d8d4ed43ca3dab45b722a49a81bbc6733fba62ddc476e0ad2d5ce2fb76'
		},
		{
			id: d1MigrationId('0026_cache_incarnation_expand.sql'),
			sha256: 'bd7265ebb8d67590e2af006f24a4cb1a4118fb09aa978442bdca0de637f3fd95'
		},
		{
			id: d1MigrationId('0027_cache_generation_contract_assertions.sql'),
			sha256: '6248a9710989d4cce216c371327c72defea432727a4a9895ffa9047c6e722ec9'
		},
		{
			id: d1MigrationId('0028_drop_cache_credential_lifecycle_guard.sql'),
			sha256: '9cff076f34b65c8043d60294ba26c1a502e71be613913e2a69b0ba2656ae2d67'
		},
		{
			id: d1MigrationId('0029_cache_identity_contract.sql'),
			sha256: 'a8e0f58e6214538717ef5194b33013c44210690e111a3b49ee261f9d28c5d155'
		},
		{
			id: d1MigrationId('0030_cache_credential_lifecycle_guard.sql'),
			sha256: '5ccef2e6f01ed99799dd2ec667e1151da903c21624e3cc10b0b1ad096e155882'
		},
		{
			id: d1MigrationId('0031_cache_lifecycle_lookup_index.sql'),
			sha256: '41f402291fb9c3ba83f2122bc3e9e8cd0ecd0480725749ce15517562a28da4e0'
		},
		{
			id: d1MigrationId('0032_chemical_silver_surfer.sql'),
			sha256: '2ee3a885f954ed234da15e32ca88a511ec74ad504e66ca8ea5fbd910c36e5afb'
		},
		{
			id: d1MigrationId('0032a_suspend_cache_credential_lifecycle_guard.sql'),
			sha256: '310f3b51a875cdf88c030396a1011f0a8ded7a6fd1d75c2729f38013792210e6'
		},
		{
			id: d1MigrationId('0033_parallel_leo.sql'),
			sha256: '1347141db42a4b7c45392f0212f64af0f03dc8ca6cd9b151fdf0830b53cbe0f4'
		},
		{
			id: d1MigrationId('0034_abnormal_the_stranger.sql'),
			sha256: '2f2758cc224637c3400c402755bca9da3930d8035d43f25e9cd0911a60f9605d'
		},
		{
			id: d1MigrationId('0034a_restore_cache_credential_lifecycle_guard.sql'),
			sha256: 'd20368041ba8a032af37fcead76a87b2d1d518dd233516f3ffee48722f08e9ae'
		},
		{
			id: d1MigrationId('0035_managed_group_access_transition.sql'),
			sha256: 'c4409febb55c7c353e59da8760078cee544ea5cbe32c789386f9f0283e99fa5c'
		},
		{
			id: d1MigrationId('0036_managed_group_access_worklist.sql'),
			sha256: 'dea0e034455c3ed6999ad95a94495ee075bb763f79ba86c7fa7e1f0fe6940bfd'
		}
	],
	durableObject: [
		{
			id: durableObjectMigrationId('0000_young_frank_castle'),
			sha256: 'dc2ae174c83f3c5bb747284024ff492a3d350cdbc74583909b92fea692caa278'
		},
		{
			id: durableObjectMigrationId('0001_overconfident_longshot'),
			sha256: '4a6094a55b0e060d75d62f1d51a246374ee21110f67ec8ff8647806dac1a7127'
		},
		{
			id: durableObjectMigrationId('0002_clumsy_glorian'),
			sha256: 'ab6ab20692914de9350894ce9c7820a407aa279e44777b9288fee117cb7e3784'
		},
		{
			id: durableObjectMigrationId('0003_living_rhino'),
			sha256: '36ede591e8acfc27486a5f28fcde006287a495c9a8190008992e919be3073f6f'
		},
		{
			id: durableObjectMigrationId('0004_pink_overlord'),
			sha256: '2284fed3ebbe4e37c65b1444ed6c8720383c360b3b684c41ad969ff86bb3bc1e'
		},
		{
			id: durableObjectMigrationId('0005_add_auth_key'),
			sha256: '56ff2c30e42a3c5569390865e98324c1d40ff978b7724d4a9122edb2c6eb754e'
		},
		{
			id: durableObjectMigrationId('0006_drop_token'),
			sha256: 'cb27e73d4297dc801a62f71a57ce60e330fd793bd23feb0d5320e38f48791049'
		},
		{
			id: durableObjectMigrationId('0007_signing_key_set'),
			sha256: '11e575a608a9b43460bc0ea710ee50ccf153833ee0ca9cf05251c63aa3aac5f8'
		},
		{
			id: durableObjectMigrationId('0008_named_caches'),
			sha256: '8b02967b6861b2701e6416faa071b0f50d79697a4de1a6f609105b91f7996a22'
		},
		{
			id: durableObjectMigrationId('0009_narinfo_deletion_cache'),
			sha256: 'd7a3ca68c5f548bbbd94b61068f51917e27e4acc3b39db6149cc324f8d762394'
		},
		{
			id: durableObjectMigrationId('0010_retention_policy'),
			sha256: '7c3ffc7e708d047a2be60b4dbb244829b303f553235c1a521f67e93e414e5aa9'
		},
		{
			id: durableObjectMigrationId('0011_verification_cursor'),
			sha256: '5419cbc76e024d9829143e3b1306045cba005d9fa38138650c4df22a2df2d30f'
		},
		{
			id: durableObjectMigrationId('0012_pending_upload_cache'),
			sha256: 'fdf13ecbc281fec03a71fb0a6198089b2b88cba1ebcdc604c648b522e5b8d81c'
		},
		{
			id: durableObjectMigrationId('0013_oidc_trust'),
			sha256: 'ef644338702b1f52baf59ea0bd3ddcb3097f8576df0d5fe65d63f0362ac644a7'
		},
		{
			id: durableObjectMigrationId('0014_pending_upload_verdict'),
			sha256: '93fa0bb845273bcad6ab1551f85f56616d0970d9a61317418646a88c10175335'
		},
		{
			id: durableObjectMigrationId('0015_blob_ref_generation'),
			sha256: '38f01eeba9c59be24077e35bf6762c5126eecc18e48632cfdd5410faa700e936'
		},
		{
			id: durableObjectMigrationId('0016_narinfo_drop_compressed'),
			sha256: '1c1a72c2f80c2d75b267f31621529a82d607d8acea036f8ae02824161f9d89ee'
		},
		{
			id: durableObjectMigrationId('0017_drop_orphan_blob_deletion'),
			sha256: '66b69c5f9c24e8ab3fda81862f367451680326b5b2554addef1df7bf74bd9e8a'
		},
		{
			id: durableObjectMigrationId('0018_tenant_identity'),
			sha256: '8e47a986125aa1c11ff6bd6571ff6d2b52ca4e441834db0922eba374ef23a4b2'
		},
		{
			id: durableObjectMigrationId('0019_wet_frank_castle'),
			sha256: '7530d20fa88c4024afdeb1249547f685f1d0974aa6a58ab50adba7a65e80805d'
		},
		{
			id: durableObjectMigrationId('0020_large_lorna_dane'),
			sha256: 'e60abba9d26d4360566c5eb416c43d1d6ed22b1d42f03ff9642e13988c89c84e'
		},
		{
			id: durableObjectMigrationId('0021_refresh_tokens'),
			sha256: 'd42de0108d666a15df09b54546f262083e6138b596b7070cfa8c0503427ad695'
		},
		{
			id: durableObjectMigrationId('0022_maintenance_indexes'),
			sha256: 'a315d211795e19d4d8547ffa9f09ab1707732985778f168df2f30fff78c6c33b'
		},
		{
			id: durableObjectMigrationId('0023_more_expiry_indexes'),
			sha256: 'cbfed8e1173c35d1541610d288d679dc4d8fab6a5b81d20a376543c05dd7b473'
		},
		{
			id: durableObjectMigrationId('0024_pending_upload_session'),
			sha256: 'bc9336bd274576fe1d39a5dc4b8a25314042b79549885cbba4aa91661f3cb791'
		},
		{
			id: durableObjectMigrationId('0025_drop_pending_upload_expected_size'),
			sha256: '7de7a584e84cf9859fd6825238b7e64e76c40aaea014ec6f1c70bf8dc5c09041'
		},
		{
			id: durableObjectMigrationId('0026_pending_upload_claimed_at'),
			sha256: '417a4bade7077b4791e6f82fc9be34346d78c956e44287d1105fdeae2f85e05e'
		},
		{
			id: durableObjectMigrationId('0027_grace_policy'),
			sha256: '6cf2c0ffcfb5b1d484f573423d9da87f90fc0a23cbf052c7a6692de36b71aad6'
		},
		{
			id: durableObjectMigrationId('0028_retention_grace'),
			sha256: 'c7a7943d630293d1309f782023e5d405a5464e0b16bd5c8cd69a20477bbcfd83'
		},
		{
			id: durableObjectMigrationId('0029_pending_upload_grace_decision'),
			sha256: 'f23ba8905066839dc8a4c86f1a8450317ade195ea0a82c27205cf36f86b55881'
		},
		{
			id: durableObjectMigrationId('0030_reuse_views'),
			sha256: '1ebdbb69fa0c3d866c097c4c88cb66108a48a0561d585b5ebf2e6c06da4549c5'
		},
		{
			id: durableObjectMigrationId('0031_retention_root_expiry_index'),
			sha256: '52e33caf93007cf666f1ceaf6b886f887bc420c6e02d7f542158b261c3677aa1'
		},
		{
			id: durableObjectMigrationId('0032_careful_chameleon'),
			sha256: '71adf4874ec9ae6b43dc4d2533bcce5230de68c720e4609fc13b0aa943b3e4d5'
		},
		{
			id: durableObjectMigrationId('0033_pending_upload_attach_root'),
			sha256: 'aeec74a11785e1b608d2fe0d84c9ca93b444c0661b394d37778b6a1590f93ffc'
		},
		{
			id: durableObjectMigrationId('0034_gc_scan_collect_phase'),
			sha256: '8c492696b06e53921ee824ef798edc267356c66b404b9517c478ea9bc2504345'
		},
		{
			id: durableObjectMigrationId('0035_chunky_unicorn'),
			sha256: '546467dd34a692f927911674948d209f45958ead14a99b6c889aec9bbb207864'
		},
		{
			id: durableObjectMigrationId('0036_retention_policy_identity'),
			sha256: '9ee93c3d7119fc0d477cd0097dc3089ef5622a1db025ffafee680554c2ce8427'
		},
		{
			id: durableObjectMigrationId('0037_wakeful_longshot'),
			sha256: '49aa1d3c8aab1eb3d0c1f98790e413c4a33c201545523836ed6fa51500dcfd5b'
		},
		{
			id: durableObjectMigrationId('0038_pending_staging_indexes'),
			sha256: '31c4dfa4f1d87493f3331cbd1fe3ed2f79f867a25c1722050c4c1134bd1b8bf4'
		},
		{
			id: durableObjectMigrationId('0039_refresh_token_families'),
			sha256: 'eeb097f2065a422b2d69b6eeaf613e5f63831abe26e4c6eaa5e95a3e690343c8'
		},
		{
			id: durableObjectMigrationId('0040_dusty_tombstone'),
			sha256: '6d6cbd988443560bae622b4f0f5288246c966c7da5d9c7e83e4b03f52e90d2be'
		},
		{
			id: durableObjectMigrationId('0041_pending_upload_recorded_verdict'),
			sha256: '3616e7b99390530a0ec3c77d282535f986c792d368d332a729e903bd30bc3303'
		},
		{
			id: durableObjectMigrationId('0042_cache_access_expand'),
			sha256: 'dd7ec242223be2cb044c771a2b096b3ee46e0f1afe4f1ff811c4c397dd66eb3b'
		},
		{
			id: durableObjectMigrationId('0043_cache_access_backfill'),
			sha256: '79e45c7e480551668f6467562c43172ade4c22a598096c82c69384b85b3f86d1'
		},
		{
			id: durableObjectMigrationId('0044_cache_grant_json'),
			sha256: 'c0e6a03d8bcada0c6cc4ef534e0aa9e81a93e99b8ccee357fc0a47fb0f5aa844'
		},
		{
			id: durableObjectMigrationId('0045_cache_incarnation_expand'),
			sha256: 'c5484a851342426cf27f0db3b9de2f3c630a1dd785d95b3ecd065e9bdef6b21e'
		},
		{
			id: durableObjectMigrationId('0046_cache_retention_expand'),
			sha256: '2bb2fe94a206290d98e3d9367616e1c76cb4446b424e1be6d1c43ccdc9b66208'
		},
		{
			id: durableObjectMigrationId('0047_cache_retention_empty_rule_set'),
			sha256: '073dbd1ca3ea84ba51807018d1da6b40b22e2144784685add1e5404140307e22'
		},
		{
			id: durableObjectMigrationId('0048_cache_retention_migration_state'),
			sha256: '459443c16ccb7185b8cd5ef4e0c7fc470bc769cb58f691339ab810d3bca3a136'
		},
		{
			id: durableObjectMigrationId('0049_cache_retention_migration_rules'),
			sha256: '868f90dc9db4d78302c3d66c1a6dac2e6de9aef9d036a2c800dab1d3b22b3497'
		},
		{
			id: durableObjectMigrationId('0050_cache_access_assertions'),
			sha256: 'ed423cdb633f2bcec398504096257095ab9901022b90e6a1f24f49f0e07597e9'
		},
		{
			id: durableObjectMigrationId('0051_cache_access_contract'),
			sha256: '5f95aea87d44f167f6ee8d7395a39f83f6b2b9f1a74e50d65b1d41f3e4610f8f'
		},
		{
			id: durableObjectMigrationId('0052_cache_access_triggers'),
			sha256: 'e146e395fcc3022a0e650dafe564a2db0055e76fa65e074dc878d9bd451fe728'
		},
		{
			id: durableObjectMigrationId('0053_yielding_scalphunter'),
			sha256: 'b90fd5f616f3060888d4c6908821c1d09c7f48d5aff2218a15abb51bd1d5c3fc'
		},
		{
			id: durableObjectMigrationId('0054_blushing_magus'),
			sha256: '461a39569810b4e306172fe88a2d9ee61cc0c6d43f450bb1a3b63dbb66eaa149'
		},
		{
			id: durableObjectMigrationId('0055_blushing_shinobi_shaw'),
			sha256: '33c089b9a6689a6b11b85bca0a0d93bf7b1268054a79a56f61e0bd4d6114ddde'
		},
		{
			id: durableObjectMigrationId('0056_small_longshot'),
			sha256: '412a5c8ae2cfe32da0b4a489ed262a9b08534336e244979940aece72f34e1905'
		},
		{
			id: durableObjectMigrationId('0057_managed_group_single_view'),
			sha256: 'c9193ff7c00702c5dcab1487cd738bcfb8578a11449de7e5e51160a35a8227bf'
		}
	]
});

export const deploymentForwardTransitions: readonly ForwardDeploymentTransition[] =
	deploymentManifest.forwardTransitions;
