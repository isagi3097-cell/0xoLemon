"""Real frozen-core metadata parity against the supplied GSE_UC serializer.

Only reads a real game fixture. Every output is retained under downloading;
credentials enter through the existing environment and are never persisted.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/vendor/gse-uc-setup'))
from gse_autosetup.core.steam_api import SteamApiClient


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def metadata_files(root):
    names = {'achievements.json', 'stats.json', 'supported_languages.txt', 'depots.txt', 'branches.json', 'items.json', 'default_items.json'}
    return {p.relative_to(root).as_posix(): digest(p) for p in sorted(root.rglob('*'))
            if p.is_file() and (p.name in names or p.relative_to(root).parts[0] in {'img', 'controller'})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--reference-settings', type=Path, required=True)
    parser.add_argument('--game', type=Path, required=True)
    parser.add_argument('--appid', type=int, required=True)
    args = parser.parse_args()
    key = os.environ.get('GSE_STEAM_WEB_API_KEY', '')
    if not key:
        raise RuntimeError('Existing Steam Web API credential environment is required.')
    base = ROOT / 'downloading/gse-parity'
    base.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='metadata-', dir=base))
    targets = [p for p in args.game.rglob('*') if p.is_file() and
               (p.name.lower() in {'steam_api.dll', 'steam_api64.dll'} or (p.parent == args.game and p.suffix.lower() == '.exe'))]
    if not targets:
        raise RuntimeError('No real game executable/Steam API target found.')
    before = {str(p): digest(p) for p in targets}
    (run / 'game-before.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    core = ROOT / 'src-tauri/resources/gse-uc/bin/gse-core.exe'
    request = {'command': 'generate_preview', 'resourceRoot': str(core.parent.parent),
               'stateRoot': str(run / 'state'), 'workRoot': str(run / 'launcher'),
               'payload': {'appId': args.appid}}
    print(f'Real frozen-core metadata run: {run}', flush=True)
    started = time.monotonic()
    with (run / 'core.jsonl').open('wb') as log:
        proc = subprocess.run([str(core)], input=json.dumps(request).encode(), stdout=log,
                              stderr=subprocess.STDOUT, timeout=600,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    events = [json.loads(line) for line in (run / 'core.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
    result = next((e['payload'] for e in events if e.get('type') == 'result'), None)
    if proc.returncode or result is None:
        raise RuntimeError(f'Frozen core failed; retained diagnostics: {run / "core.jsonl"}')
    launcher = Path(result['settingsPath'])
    print(f'Frozen core succeeded in {time.monotonic() - started:.1f}s; comparing reference metadata.', flush=True)
    reference = run / 'reference-enriched'
    for source in args.reference_settings.rglob('*'):
        if source.is_file():
            target = reference / source.relative_to(args.reference_settings)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    # Load the actual supplied serializer, not the launcher's copy. Only its
    # metadata outputs are compared: user/overlay INI preferences can differ.
    spec = importlib.util.spec_from_file_location('reference_config_builder', args.reference / 'gse_autosetup/core/config_builder.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    steam = SteamApiClient(key)
    schema = steam.get_schema(args.appid)
    languages = (reference / 'supported_languages.txt').read_text(encoding='utf-8-sig').splitlines()
    localized = steam.get_localized_schemas(args.appid, languages, strict=True)
    builder.write_basic_settings(reference, args.appid, schema, '0xoLemon', steam.download_file,
                                 localized_schemas=localized)
    expected, actual = metadata_files(reference), metadata_files(launcher)
    missing = sorted(set(expected) - set(actual))
    differing = sorted(p for p in expected.keys() & actual.keys() if expected[p] != actual[p])
    achievements = json.loads((launcher / 'achievements.json').read_text(encoding='utf-8'))
    unchanged = all(digest(Path(path)) == value for path, value in before.items())
    evidence = {'appId': args.appid, 'metadataWorkflow': result['metadataWorkflow'],
                'metadataParityVerified': not missing and not differing and bool(achievements),
                'comparedFileCount': len(expected), 'missing': missing, 'differentBytes': differing,
                'launcherSettings': str(launcher), 'referenceSettings': str(reference),
                'achievementCount': len(achievements), 'languageCount': len(localized),
                'referenceFiles': expected, 'launcherFiles': actual, 'coreSha256': digest(core),
                'gameFilesUnchanged': unchanged, 'gameFilesBefore': before, 'gameLaunched': False}
    (run / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in evidence.items() if k not in {'referenceFiles', 'launcherFiles', 'gameFilesBefore'}}, indent=2))
    print(f'Evidence: {run / "evidence.json"}')
    if not evidence['metadataParityVerified'] or not unchanged:
        raise RuntimeError('Metadata parity failed; inspect the retained hash differences.')


if __name__ == '__main__':
    main()
