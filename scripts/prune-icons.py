"""Archive artwork excluded by the curated catalog (original pack is untouched)."""
import argparse
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
parser.add_argument('--archive', type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
archive = args.archive.resolve()
allowed = {name for group in json.loads((root / 'server/icon-catalog.json').read_text()).values() for name in group}
for folder in ('public', 'dist'):
    directory = root / folder / 'private-food-icons'
    if directory in archive.parents or archive == directory:
        raise SystemExit('Archive must be outside the served icon directory.')
    if not directory.exists():
        continue
    removed = 0
    for path in sorted(directory.glob('*.png')):
        if path.stem in allowed:
            continue
        destination = archive / folder / path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and destination.read_bytes() != path.read_bytes():
            raise SystemExit(f'Archive collision: {destination}')
        shutil.copy2(path, destination)
        path.unlink()
        removed += 1
    print(f'{folder}: retained {len(list(directory.glob("*.png")))} icons, archived {removed}')
