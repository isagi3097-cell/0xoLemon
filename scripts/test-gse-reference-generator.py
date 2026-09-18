"""Read-only game fixture, real reference generator, retained hash evidence.

Outputs are isolated under downloading. Never applies DLLs or cleans folders.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def files(root):
    return {p.relative_to(root).as_posix(): {'sha256': digest(p), 'size': p.stat().st_size}
            for p in sorted(root.rglob('*')) if p.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--launcher-settings', type=Path)
    parser.add_argument('--appid', required=True, type=int)
    parser.add_argument('--game', required=True, type=Path)
    parser.add_argument('--mode', choices=('full', 'reference-service'), default='full',
                        help='reference-service matches the supplied service.py generator flags; achievement Web API enrichment is not run here')
    parser.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 600:
        parser.error('--timeout must be between 1 and 600 seconds')
    repo = Path(__file__).resolve().parents[1]
    base = repo / 'downloading/gse-parity'
    base.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='reference-', dir=base))
    game_targets = [p for p in args.game.rglob('*') if p.is_file()
                    and (p.name.lower() in {'steam_api.dll', 'steam_api64.dll'}
                         or (p.parent == args.game and p.suffix.lower() == '.exe'))]
    if not game_targets:
        raise RuntimeError('No actual game executable/Steam API fixture found.')
    before = {str(p): digest(p) for p in game_targets}
    (run / 'game-before.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    exe = next(args.reference.rglob('generate_emu_config.exe'))
    # -rel_out changes only destination. A fresh output does not require -clr;
    # full -def1/-anon semantics and all achievement generation remain intact.
    command = [str(exe), '-def1', '-anon', '-rel_out', str(args.appid)]
    if args.mode == 'reference-service':
        command.insert(-1, '-skip_ach')
    print(f'Reference generator started; evidence: {run}', flush=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith('_PYI_')
           and k not in {'PYTHONHOME', 'PYTHONPATH', '_MEIPASS', '_MEIPASS2'}}
    env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    env['PYTHONUNBUFFERED'] = '1'
    try:
        with (run / 'generator.log').open('wb') as log:
            result = subprocess.run(command, cwd=run, env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT, timeout=args.timeout,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired:
        evidence = {'appId': args.appid, 'status': 'referenceGeneratorTimeout', 'timeoutSeconds': args.timeout,
                    'mode': args.mode, 'command': command,
                    'referenceGeneratorSha256': digest(exe), 'gameFilesBefore': before,
                    'gameFilesUnchanged': all(digest(Path(p)) == h for p, h in before.items()),
                    'metadataParityVerified': False, 'gameLaunched': False}
        (run / 'evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
        raise RuntimeError(f'Reference generator timed out; evidence retained at {run}') from None
    if result.returncode != 0:
        raise RuntimeError(f'Reference generator failed with exit {result.returncode}; see {run / "generator.log"}')
    settings = run / '_OUTPUT' / str(args.appid) / 'steam_settings'
    report = {'appId': args.appid, 'referenceGeneratorSha256': digest(exe),
              'mode': args.mode, 'command': command, 'metadataParityVerified': False,
              'referenceSettings': str(settings), 'referenceFiles': files(settings),
              'gameFilesUnchanged': all(digest(Path(p)) == h for p, h in before.items()),
              'gameFilesBefore': before, 'gameLaunched': False, 'gameFilesMutated': False}
    if args.launcher_settings:
        launcher = files(args.launcher_settings)
        reference = report['referenceFiles']
        report['launcherSettings'] = str(args.launcher_settings)
        report['launcherFiles'] = launcher
        report['missingInLauncher'] = sorted(set(reference) - set(launcher))
        report['differentBytes'] = [p for p in reference.keys() & launcher.keys() if reference[p] != launcher[p]]
    for name, root in [('reference', settings), ('launcher', args.launcher_settings)]:
        if root and (root / 'achievements.json').is_file():
            achievements = json.loads((root / 'achievements.json').read_text(encoding='utf-8-sig'))
            report[name + 'AchievementCount'] = len(achievements)
            report[name + 'Languages'] = sorted({lang for a in achievements for key in ['displayName', 'description']
                                                if isinstance(a.get(key), dict) for lang in a[key]})
    (run / 'evidence.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if not k.endswith('Files') and k != 'gameFilesBefore'}, indent=2))
    print(f'Evidence saved: {run / "evidence.json"}')


if __name__ == '__main__':
    main()
