"""Audit the pinned CSED-R files already fetched from the author repository.

Only counts, hashes, and row identifiers enter the public audit artifact.
No label mapping to our semantic-noise task is performed here.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.research/dataset-audit'


def audit():
    manifest = json.loads((WORK / 'csed-r-audit.json').read_text(encoding='utf-8-sig'))
    by_split = {}
    stats = []
    for expected in manifest['stats']:
        name = expected['split']
        raw = (WORK / f'csed-r-{name}.tsv').read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        assert digest == expected['sha256'], f'{name}: source bytes changed'
        groups = defaultdict(list)
        labels = Counter()
        extra_tabs = []
        # splitlines() also splits embedded Unicode separators inside text.
        lines = raw.decode('utf-8-sig').split('\n')
        if lines[-1] == '':
            lines.pop()
        for row, line in enumerate(lines, 1):
            line = line.removesuffix('\r')
            label, text = line.split('\t', 1)
            assert label in ('0', '1') and text.strip(), (name, row)
            key = ' '.join(text.split())
            labels[label] += 1
            groups[key].append({'row': row, 'label': int(label)})
            if '\t' in text:
                extra_tabs.append(row)
        assert sum(labels.values()) == expected['rows']
        conflicts = [v for v in groups.values() if len({x['label'] for x in v}) > 1]
        stats.append({
            'split': name, 'rows': sum(labels.values()), 'label_counts': dict(labels),
            'unique_whitespace_normalized_texts': len(groups),
            'duplicate_extra_rows': sum(len(v)-1 for v in groups.values()),
            'conflicting_label_groups': len(conflicts),
            'conflicting_rows': conflicts[:10], 'rows_with_embedded_tabs': extra_tabs,
            'bytes': len(raw), 'sha256': digest,
        })
        by_split[name] = groups
    overlap = []
    for left, right in [('train', 'dev'), ('train', 'test'), ('dev', 'test')]:
        shared = set(by_split[left]) & set(by_split[right])
        conflict = [t for t in shared if
                    {x['label'] for x in by_split[left][t]} !=
                    {x['label'] for x in by_split[right][t]}]
        overlap.append({'left': left, 'right': right, 'shared_unique_texts': len(shared),
                        'different_label_set_texts': len(conflict),
                        'example_row_ids': [
                            {'text_sha256': hashlib.sha256(t.encode()).hexdigest(),
                             left: by_split[left][t], right: by_split[right][t]}
                            for t in sorted(shared)[:10]]})
    return {
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
        'dataset': 'CSED-R', 'author_repository': 'https://github.com/wyxstriker/CSED',
        'revision': manifest['revision'],
        'author_repository_license': 'Apache-2.0',
        'normalization': 'Collapse whitespace only; preserve case and punctuation.',
        'labels': {'0': 'no semantic error', '1': 'semantic error (not necessarily gibberish)'},
        'splits': stats, 'cross_split_overlap': overlap,
        'task_caveat': 'Exam-style semantic diagnosis. Do not automatically map every error to our noise class.',
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/semantic-dataset-audit.json')
    args = parser.parse_args()
    result = audit()
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
