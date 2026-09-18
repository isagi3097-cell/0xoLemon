"""GSE_UC metadata workflow: generator configuration + Steam Web API schema.

Both sources are mandatory in this mode. No error selects a reduced workflow,
and all validation happens in per-run staging before an installer sees output.
"""
from __future__ import annotations

import json
from pathlib import Path

from .config_builder import write_schema_settings
from .official_generator import run_official_generator, validate_generated_schema
from .steam_api import STEAM_PLATFORM_LANGUAGES, SteamApiClient


def generate_complete_settings(
    tools_root: Path,
    appid: int,
    steam: SteamApiClient,
    schema: dict,
    *,
    log=None,
    progress=None,
    output_root: Path | None = None,
) -> Path:
    log = log or (lambda _message: None)
    progress = progress or (lambda _percent, _message: None)
    log("Metadata workflow: GSE_UC generator configuration + Steam Web API achievements/stats/localization; no automatic fallback.")
    # This is the supplied GSE_UC service's primary workflow, not a retry after
    # failure. Anonymous owner scanning is replaced by mandatory Web API schema.
    settings = run_official_generator(
        tools_root, appid, skip_achievements=True, output_root=output_root,
        log=log, progress=lambda p, message: progress(int(p * 0.7), message),
    )
    language_file = settings / "supported_languages.txt"
    languages = list(STEAM_PLATFORM_LANGUAGES)
    if language_file.is_file():
        languages = list(dict.fromkeys(
            line.strip().lower() for line in language_file.read_text(encoding="utf-8-sig").splitlines()
            if line.strip() and not line.lstrip().startswith(("#", ";"))
        )) or languages
    if "english" not in languages:
        languages.insert(0, "english")
    localized = steam.get_localized_schemas(
        appid, languages, strict=True,
        progress=lambda done, total, lang: progress(70 + int(done / max(total, 1) * 15), f"Achievement localization {done}/{total}: {lang}"),
    )
    expected = {a['name'] for a in schema.get('game', {}).get('availableGameStats', {}).get('achievements', []) if a.get('name')}
    for language in languages:
        translated = localized.get(language, {}).get('game', {}).get('availableGameStats', {}).get('achievements', [])
        present = {a['name'] for a in translated if a.get('name')}
        if not expected.issubset(present):
            raise RuntimeError(f"GSE_GENERATOR_METADATA_INCOMPLETE: achievement IDs missing for {language}.")

    downloaded = 0

    def download_icon(url: str, destination: Path) -> bool:
        nonlocal downloaded
        if not steam.download_file(url, destination):
            # Do not include a remote URL in the error; never leak credentials.
            raise RuntimeError(f"GSE_GENERATOR_METADATA_INCOMPLETE: achievement artwork download failed ({destination.name}).")
        downloaded += 1
        progress(85, f"Achievement images: {downloaded}")
        return True

    # Reuse the exact GSE_UC serializer, leaving generator languages, depot,
    # branch, controller and INI bytes untouched. Preset schemas also retain
    # their bytes; validation below prevents an incomplete preset being used.
    counts = write_schema_settings(
        settings, schema, download_icon, localized_schemas=localized,
        preserve_existing_achievements=(settings / 'achievements.json').is_file(),
        preserve_existing_stats=(settings / 'stats.json').is_file(),
    )
    validate_generated_schema(settings, schema)
    if expected:
        achievements = json.loads((settings / 'achievements.json').read_text(encoding='utf-8-sig'))
        source = {a['name']: a for a in schema['game']['availableGameStats']['achievements'] if a.get('name')}
        resolved_root = settings.resolve()
        for achievement in achievements:
            original = source.get(achievement.get('name'))
            if original is None:
                continue
            for field, upstream in (('icon', 'icon'), ('icon_gray', 'icongray')):
                if not original.get(upstream):
                    continue
                relative = achievement.get(field)
                target = (settings / str(relative or '')).resolve()
                if not relative or not target.is_relative_to(resolved_root) or not target.is_file() or target.stat().st_size == 0:
                    raise RuntimeError(f"GSE_GENERATOR_METADATA_INCOMPLETE: missing {field} for {achievement['name']}.")
    log(f"Validated GSE_UC metadata: {counts['achievements']} achievements, {counts['stats']} stats, {len(localized)} language schemas, {downloaded} downloaded images.")
    progress(100, "GSE_UC metadata verified; ready for deployment.")
    return settings
