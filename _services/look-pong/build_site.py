"""Export the game for GitHub Pages; never copy credentials or local artifacts."""
import argparse
import hashlib
import html
import json
import shutil
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent


def build(destination, *, api_origin='https://pong-api.josephofiowa.com', vendor=None):
    parsed = urlparse(api_origin)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Use an HTTPS API origin without a path or credentials.')
    destination = Path(destination)
    vendor = Path(vendor) if vendor else ROOT / 'node_modules/inferencejs/dist/inference.es.js'
    if not vendor.is_file():
        raise FileNotFoundError('Run npm ci before exporting the browser library.')
    (destination / 'assets').mkdir(parents=True, exist_ok=True)
    (destination / 'vendor').mkdir(exist_ok=True)
    versions = {}
    for source in (ROOT / 'web').iterdir():
        if source.suffix not in ('.js', '.css'):
            continue
        shutil.copyfile(source, destination / 'assets' / source.name)
        path = f'/look-pong/assets/{source.name}'
        versions[path] = f'{path}?v={hashlib.sha256(source.read_bytes()).hexdigest()[:16]}'
    shutil.copyfile(vendor, destination / 'vendor/inference.es.js')
    page = (ROOT / 'web/index.html').read_text()
    page = page.replace('href="/"', 'href="/look-pong/"')
    page = page.replace('/assets/', '/look-pong/assets/')
    page = page.replace('name="pong-api-origin" content=""', f'name="pong-api-origin" content="{html.escape(api_origin.rstrip("/"), quote=True)}"')
    page = page.replace('Camera frames stay on this computer. No video is saved.', 'Camera frames are sent to Roboflow. No video is saved by this app.')
    for path, versioned in versions.items():
        page = page.replace(f'"{path}"', f'"{versioned}"')
    imports = {path: versioned for path, versioned in versions.items() if path.endswith('.js')}
    vendor_path = '/look-pong/vendor/inference.es.js'
    imports[vendor_path] = vendor_path + '?v=' + hashlib.sha256(vendor.read_bytes()).hexdigest()[:16]
    page = page.replace('<script type="module"', '<script type="importmap">' + json.dumps({'imports': imports}) + '</script>\n  <script type="module"', 1)
    (destination / 'index.html').write_text(page)
    (destination / 'vendor/NOTICE.txt').write_text('inferencejs 1.3.0 by Roboflow; npm package declares the ISC license.\nSource: https://github.com/roboflow/inferencejs\nBundled distribution retains its upstream dependency license notices.\n')
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, default=ROOT.parents[1] / 'look-pong')
    parser.add_argument('--api-origin', default='https://pong-api.josephofiowa.com')
    parser.add_argument('--vendor', type=Path)
    args = parser.parse_args()
    print(build(args.destination, api_origin=args.api_origin, vendor=args.vendor))
