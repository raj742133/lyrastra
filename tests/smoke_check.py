"""Offline package smoke checks for Lyrastra. Run: python tests/smoke_check.py"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['manifest_version'] == 3
assert manifest['version'] == '0.8.0'
assert 'https://lrclib.net/*' in manifest['host_permissions']
assert 'tabs' in manifest.get('permissions', [])
for script in ('background.js', 'content.js', 'spotify.js', 'viewer.js'):
    path = ROOT / script
    assert path.is_file(), f'Missing {script}'
    result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(f'JavaScript syntax error in {script}:\n{result.stderr}')
for script in manifest['content_scripts']:
    for filename in script['js'] + script.get('css', []):
        assert (ROOT / filename).is_file(), f'Missing manifest reference: {filename}'
for filename in ('viewer.html', 'content.css', 'README.md', 'icons/16.png', 'icons/48.png', 'icons/128.png'):
    assert (ROOT / filename).is_file(), f'Missing package file: {filename}'
viewer = (ROOT / 'viewer.js').read_text(encoding='utf-8')
background = (ROOT / 'background.js').read_text(encoding='utf-8')
assert 'visibilitychange' in viewer and 'cancelAnimationFrame' in viewer
assert 'prefers-reduced-motion' in viewer
assert 'Require a credible title match' in background
assert "counts.beng" in background and "counts.beng" in viewer
print('PASS: manifest, referenced files, JavaScript syntax, reduced-motion/visibility handling, and lyric-match guards')
print('NOTE: Live Spotify/YouTube Music selectors and LRCLIB network behaviour require manual Chrome testing.')
