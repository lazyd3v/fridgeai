"""Score supplied fixture results locally; expected answers never enter model inputs."""
import json
import re
import sys
from pathlib import Path

def product_kind(name):
    name = name.casefold()
    if 'juice' in name:
        return 'juice'
    if 'potato' in name:
        return 'potatoes'
    if 'cheese' in name or 'parmigiano' in name or 'parmesan' in name:
        return 'cheese'
    return name

rows = json.loads(Path(sys.argv[1]).read_text())
scores = []
for row in sorted(rows, key=lambda r: (r['attempt'], r['label'])):
    events = row.get('observed', {}).get('events', [])
    expected = ['juice', 'potatoes', 'cheese'] if row['label'] == 'first' else ['cheese', 'potatoes', 'juice']
    action = 'removed' if row['label'] == 'first' else 'added'
    errors = []
    if not row.get('schemaValid'):
        errors.append('invalid output: ' + row.get('error', 'unknown error'))
    if [product_kind(e['product']) for e in events] != expected:
        errors.append('wrong products, count, or chronological order')
    if any(e['action'] != action for e in events):
        errors.append('wrong direction')
    for event in events:
        date = event.get('expirationDate')
        if '--visual-only' not in sys.argv and row['label'] == 'second' and product_kind(event['product']) == 'cheese':
            if not isinstance(date, str) or not re.fullmatch(r'(?:good\s+)?(?:until\s+)?july\s+2027', date.strip(), re.I):
                errors.append('cheese date must preserve July 2027 precision')
        elif date is not None:
            errors.append('unexpected date')
    scores.append({'clip': row['label'], 'attempt': row['attempt'], 'pass': not errors, 'errors': errors})
keys = {(r['label'], r['attempt']) for r in rows}
complete = len(rows) == 4 and keys == {('first', 1), ('second', 1), ('first', 2), ('second', 2)}
print(json.dumps({'complete': complete, 'passed': sum(s['pass'] for s in scores), 'total': len(rows), 'allPassed': complete and all(s['pass'] for s in scores), 'trials': scores}, indent=2))
