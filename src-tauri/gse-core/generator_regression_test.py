"""Generator/transport regressions. Only isolated exact-owned files are created."""
import os
import sys
import tempfile
import time
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'src/vendor/gse-uc-setup'), str(Path(__file__).parent)]
from gse_autosetup.core import official_generator as generator
from gse_autosetup.core import metadata_pipeline
from gse_autosetup import service as setup_service
from gse_autosetup.core.models import GameMetadata, SteamApiTarget
from gse_autosetup.core.steam_api import SteamApiClient
from gse_autosetup.core.config_builder import write_basic_settings
import gse_core_bridge as bridge


class GeneratorRegressionTests(unittest.TestCase):
    def setUp(self):
        base = ROOT / 'downloading/gse-regression'
        base.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=base))

    def test_missing_md5_is_rejected_before_launch(self):
        exe = self.root / 'generate_emu_config.exe'
        exe.write_bytes(b'MZ')
        (self.root / '_internal').mkdir()
        with patch.object(generator.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'GSE_GENERATOR_RESOURCE_MISSING'):
                generator.run_official_generator(self.root, 945360, output_root=self.root / 'output')
            spawn.assert_not_called()

    def test_another_app_output_is_never_accepted(self):
        (self.root / '_OUTPUT/480/steam_settings').mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, 'no steam_settings'):
            generator.find_generated_settings(self.root, 945360)

    def test_full_command_keeps_canonical_preset_and_achievements(self):
        self.assertEqual(generator.build_generator_command(Path('generator.exe'), 945360),
                         ['generator.exe', '-def1', '-anon', '-rel_out', '945360'])

    def test_fatal_native_module_output_fails_immediately(self):
        script = "print(\"OSError: Cannot load native module 'Cryptodome.Hash._MD5'\", flush=True); import time; time.sleep(30)"
        with patch.object(generator, 'find_generator_executable', return_value=Path(sys.executable)), \
             patch.object(generator, 'build_generator_command', return_value=[sys.executable, '-c', script]):
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'PyCryptodome'):
                generator.run_official_generator(self.root, 945360, output_root=self.root / 'output', timeout=8)
            self.assertLess(time.monotonic() - started, 6)

    def test_canonical_localization_is_byte_preserved_and_overwrite_rejected(self):
        source, dest = self.root / 'source', self.root / 'dest'
        source.mkdir()
        data = b'[{"name":"ACH","displayName":{"english":"Win","french":"Victoire"}}]'
        (source / 'achievements.json').write_bytes(data)
        generator.merge_settings_tree(source, dest)
        generator.validate_settings_mirror(source, dest)
        self.assertEqual((dest / 'achievements.json').read_bytes(), data)
        (dest / 'achievements.json').write_text('[]', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'canonical metadata changed'):
            generator.validate_settings_mirror(source, dest)

    def test_zero_settings_are_not_replaced_with_defaults(self):
        with patch.dict(os.environ, {'GSE_STEAM_WEB_API_KEY': 'x' * 32}):
            inputs = bridge._to_inputs({'appId': 945360, 'gameFolder': str(self.root),
                'overlayRounding': 0, 'overlayAnimation': 0, 'overlayRendererTimeout': 0})
            self.assertEqual((inputs.overlay_rounding, inputs.overlay_animation, inputs.overlay_renderer_timeout), (0, 0, 0))

    def test_full_generator_missing_metadata_cannot_fall_back(self):
        schema = {'game': {'availableGameStats': {'achievements': [{'name': 'ACH_WIN'}]}}}
        with self.assertRaisesRegex(RuntimeError, 'METADATA_INCOMPLETE'):
            generator.validate_generated_schema(self.root, schema)
        (self.root / 'achievements.json').write_text('[{"name":"OTHER"}]', encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'METADATA_INCOMPLETE'):
            generator.validate_generated_schema(self.root, schema)
        (self.root / 'achievements.json').write_text('[{"name":"ACH_WIN"}]', encoding='utf-8')
        generator.validate_generated_schema(self.root, schema)

    def test_nested_runtime_environment_is_not_inherited(self):
        with patch.dict(os.environ, {'_PYI_APPLICATION_HOME_DIR': 'parent', 'PYTHONPATH': 'parent'}):
            env = generator.clean_subprocess_env()
            self.assertNotIn('_PYI_APPLICATION_HOME_DIR', env)
            self.assertNotIn('PYTHONPATH', env)
            self.assertEqual(env['PYINSTALLER_RESET_ENVIRONMENT'], '1')

    def test_foreign_mei_directory_is_stripped_from_path(self):
        # A frozen launcher leaks its private extraction dir onto PATH; the
        # standalone onedir generator must resolve its own _internal native
        # modules (Cryptodome.Hash._MD5) and never a foreign _MEI copy.
        keep = str(self.root / 'gen' / '_internal')
        foreign = os.path.join(os.environ.get('TEMP', self.root.as_posix()), '_MEIabcdef')
        with patch.dict(os.environ, {'PATH': os.pathsep.join([keep, foreign, 'C:/Windows/System32'])}):
            env = generator.clean_subprocess_env()
            entries = env['PATH'].split(os.pathsep)
            self.assertNotIn(foreign, entries)
            self.assertIn(keep, entries)
            self.assertIn('C:/Windows/System32', entries)

    def test_extra_path_override_cannot_reintroduce_foreign_mei(self):
        # run_official_generator builds extra_env['PATH'] from os.environ['PATH'],
        # which still carries the frozen parent's _MEI dir. If the override were
        # applied verbatim it would silently reinstate the entry we removed and
        # the generator would load Cryptodome from the wrong runtime again.
        foreign = os.path.join(os.environ.get('TEMP', self.root.as_posix()), '_MEIparent')
        internal = str(self.root / 'gen' / '_internal')
        parent_path = os.pathsep.join([foreign, 'C:/Windows/System32'])
        with patch.dict(os.environ, {'PATH': parent_path}):
            override = os.pathsep.join([internal, str(self.root / 'gen'), parent_path])
            env = generator.clean_subprocess_env({'PATH': override})
            entries = env['PATH'].split(os.pathsep)
            self.assertNotIn(foreign, entries)
            self.assertIn(internal, entries)
            self.assertIn('C:/Windows/System32', entries)

    def metadata_fixture(self):
        settings = self.root / 'steam_settings'
        settings.mkdir()
        (settings / 'supported_languages.txt').write_bytes(b'english\nfrench\n')
        (settings / 'depots.txt').write_bytes(b'945361\n')
        schema = {'game': {'availableGameStats': {'achievements': [
            {'name': 'ACH_WIN', 'displayName': 'Win', 'description': 'Victory',
             'icon': 'https://example.invalid/icon.jpg', 'icongray': 'https://example.invalid/gray.jpg'}
        ], 'stats': [{'name': 'WINS', 'type': 'INT', 'defaultvalue': 0}]}}}
        french = {'game': {'availableGameStats': {'achievements': [
            {'name': 'ACH_WIN', 'displayName': 'Gagner', 'description': 'Victoire'}]}}}
        steam = Mock()
        steam.get_localized_schemas.return_value = {'english': schema, 'french': french}
        def download(_url, target):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'fixture-image')
            return True
        steam.download_file.side_effect = download
        return settings, schema, steam

    def test_reference_workflow_enriches_before_deployment_without_retry(self):
        settings, schema, steam = self.metadata_fixture()
        with patch.object(metadata_pipeline, 'run_official_generator', return_value=settings) as run:
            result = metadata_pipeline.generate_complete_settings(self.root, 945360, steam, schema)
        self.assertEqual(result, settings)
        self.assertEqual(run.call_count, 1)
        self.assertTrue(run.call_args.kwargs['skip_achievements'])
        self.assertTrue(steam.get_localized_schemas.call_args.kwargs['strict'])
        achievement = json.loads((settings / 'achievements.json').read_text(encoding='utf-8'))[0]
        self.assertEqual(achievement['displayName'], {'english': 'Win', 'french': 'Gagner'})
        self.assertTrue((settings / achievement['icon']).is_file())
        self.assertTrue((settings / achievement['icon_gray']).is_file())
        self.assertEqual((settings / 'depots.txt').read_bytes(), b'945361\n')
        self.assertFalse((settings / 'configs.user.ini').exists())

    def test_reference_workflow_stops_on_missing_artwork_or_translation(self):
        settings, schema, steam = self.metadata_fixture()
        steam.download_file.side_effect = None
        steam.download_file.return_value = False
        with patch.object(metadata_pipeline, 'run_official_generator', return_value=settings) as run:
            with self.assertRaisesRegex(RuntimeError, 'artwork download failed'):
                metadata_pipeline.generate_complete_settings(self.root, 945360, steam, schema)
            self.assertEqual(run.call_count, 1)
            steam.get_localized_schemas.return_value.pop('french')
            with self.assertRaisesRegex(RuntimeError, 'IDs missing for french'):
                metadata_pipeline.generate_complete_settings(self.root, 945360, steam, schema)

    def test_generator_failure_does_not_clean_game_or_report_deployment_phase(self):
        progress = Mock()
        instance = object.__new__(setup_service.SetupService)
        instance.log, instance.progress = Mock(), progress
        instance._prepare_gse_package = Mock()
        instance._steam_context = Mock(return_value=(Mock(), {}, GameMetadata(945360, 'Among Us')))
        instance._ensure_tools = Mock(return_value=(self.root, 'fixture'))
        target = SteamApiTarget(self.root / 'steam_api.dll', 'x86')
        with patch.object(setup_service, 'scan_steam_api_targets', return_value=[target]), \
             patch.object(setup_service, 'generate_complete_settings', side_effect=RuntimeError('fixture failure')) as run, \
             patch.object(setup_service, 'clean_previous_emulator_state') as cleanup:
            with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                instance._run_gse(setup_service.Inputs(945360, self.root, 'test-only'))
        self.assertEqual(run.call_count, 1)
        cleanup.assert_not_called()
        self.assertNotIn(66, [call.args[0] for call in progress.call_args_list])

    def test_strict_localization_rejects_missing_language(self):
        steam = SteamApiClient('test-only')
        def fetch(_appid, language, _session):
            if language == 'french':
                raise RuntimeError('fixture network failure')
            return {'game': {}}
        with patch.object(steam, '_get_schema_with_session', side_effect=fetch):
            with self.assertRaisesRegex(RuntimeError, 'localization incomplete: french'):
                steam.get_localized_schemas(945360, ['english', 'french'], strict=True)

    def test_full_settings_writer_still_delegates_metadata_and_preferences(self):
        settings, schema, steam = self.metadata_fixture()
        counts = write_basic_settings(settings, 945360, schema, 'Player', steam.download_file,
                                      overlay_rounding=0, overlay_animation=0,
                                      localized_schemas=steam.get_localized_schemas.return_value)
        self.assertEqual(counts, {'achievements': 1, 'stats': 1})
        self.assertIn('account_name=Player', (settings / 'configs.user.ini').read_text())
        self.assertIn('Notification_Rounding=0.0', (settings / 'configs.overlay.ini').read_text())
        self.assertEqual((settings / 'supported_languages.txt').read_bytes(), b'english\nfrench\n')

    def test_parallel_localization_keeps_requested_language_order(self):
        steam = SteamApiClient('test-only')
        def fetch(_appid, language, _session):
            if language == 'french':
                time.sleep(0.03)
            return {'game': {}}
        with patch.object(steam, '_get_schema_with_session', side_effect=fetch):
            result = steam.get_localized_schemas(945360, ['french', 'english'], strict=True)
        self.assertEqual(list(result), ['french', 'english'])

    @unittest.skipUnless(sys.platform == 'win32', 'Windows loader state')
    def test_windows_dll_search_restored_even_on_spawn_error(self):
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.SetDllDirectoryW.argtypes = [ctypes.c_wchar_p]
        buffer = ctypes.create_unicode_buffer(32768)
        kernel.GetDllDirectoryW(len(buffer), buffer)
        original = buffer.value
        try:
            self.assertTrue(kernel.SetDllDirectoryW(str(self.root)))
            with self.assertRaisesRegex(RuntimeError, 'spawn failed'):
                with generator.external_dll_search():
                    kernel.GetDllDirectoryW(len(buffer), buffer)
                    self.assertEqual(buffer.value, '')
                    raise RuntimeError('spawn failed')
            kernel.GetDllDirectoryW(len(buffer), buffer)
            self.assertEqual(buffer.value, str(self.root))
        finally:
            kernel.SetDllDirectoryW(original or None)


if __name__ == '__main__':
    unittest.main(verbosity=2)
