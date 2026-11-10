"""Generate weighted keystrokes directly from an archived physical-entropy stream.

No PRNG expansion or OS RNG fallback. Generation is exactly replayable from the
provider response. Outputs are unlabelled IME experiment candidates, not gold.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import string

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ['waerffadsg', 'kop[[kl;kl;']


class Entropy:
    def __init__(self, raw, end_bit=None):
        values = [int(x) for x in raw.split()]
        if len(values) != 10000 or any(not 0 <= v < 65536 for v in values):
            raise ValueError('Expected archived 10000 uniform uint16 values')
        self.raw = b''.join(v.to_bytes(2, 'little') for v in values)
        self.end_bit = len(self.raw)*8 if end_bit is None else end_bit
        if not 0 < self.end_bit <= len(self.raw)*8:
            raise ValueError('Invalid archived entropy end bit')
        self.offset = 0

    def bits(self, width):
        if self.offset + width > self.end_bit:
            raise RuntimeError('Physical entropy exhausted; no pseudorandom fallback')
        value = 0
        for shift in range(width):
            i = self.offset
            value |= ((self.raw[i // 8] >> (i % 8)) & 1) << shift
            self.offset += 1
        return value

    def below(self, upper):
        width = (upper - 1).bit_length()
        while True:
            value = self.bits(width)
            if value < upper:
                return value

    def weighted(self, weights):
        value = self.below(sum(weights.values()))
        for key, weight in weights.items():
            if value < weight:
                return key
            value -= weight
        raise AssertionError('Invalid weighted draw')


def generate(raw, count, start_bit=0, id_prefix='kb', all_test=False, end_bit=None):
    counts = Counter(''.join(SAMPLES))
    # Seen letters follow observed counts; an unseen letter has 1/10 of the
    # weight of a once-observed letter. Punctuation is a separate condition.
    letters = {c: 10 * counts[c] if counts[c] else 1 for c in string.ascii_lowercase}
    extended = {**letters, '[': 10 * counts['['], ';': 10 * counts[';']}
    entropy = Entropy(raw, end_bit)
    if not 0 <= start_bit < entropy.end_bit:
        raise ValueError('Invalid archived entropy start bit')
    entropy.offset = start_bit
    rows = []
    for i in range(count):
        start = entropy.offset
        # Two conditions remain explicit. User requested one final Space only.
        condition = 'letters' if i % 4 != 3 else 'letters-and-observed-punctuation'
        weights = letters if condition == 'letters' else extended
        length = 8 + entropy.below(25)
        text = ''.join(entropy.weighted(weights) for _ in range(length))
        split = 'test' if all_test else ['train', 'train', 'train', 'train', 'cal', 'test'][i % 6]
        rows.append({'id': f'{id_prefix}-{i+1:04d}', 'split': split, 'condition': condition,
                     'keys': text, 'commit_key': 'space', 'label': None,
                     'label_status': 'unreviewed', 'entropy_bit_start': start,
                     'entropy_bit_end': entropy.offset})
    return {'source_samples': SAMPLES, 'observed_counts': dict(sorted(counts.items())),
            'letter_weights': letters, 'extended_weights': extended,
            'algorithm': 'Archived uint16 little-endian bits, LSB first; rejection sampling (no modulo bias); integer cumulative weights.',
            'entropy_bits_consumed': entropy.offset, 'rows': rows}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--entropy', type=Path, required=True)
    p.add_argument('--metadata', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--count', type=int, default=120)
    p.add_argument('--start-bit', type=int, default=0)
    p.add_argument('--end-bit', type=int, help='Exclusive reserved entropy boundary; exhaustion stops without writing')
    p.add_argument('--id-prefix', default='kb')
    p.add_argument('--all-test', action='store_true')
    args = p.parse_args()
    if not 6 <= args.count <= 10000:
        raise ValueError('Count must be 6..10000; entropy exhaustion is fatal')
    raw = args.entropy.read_bytes()
    meta = json.loads(args.metadata.read_text(encoding='utf-8-sig'))
    if hashlib.sha256(raw).hexdigest() != meta['raw_sha256']:
        raise ValueError('Entropy archive checksum mismatch')
    if not args.id_prefix.isalnum():
        raise ValueError('ID prefix must be alphanumeric')
    result = generate(raw, args.count, args.start_bit, args.id_prefix, args.all_test, args.end_bit)
    assert result == generate(raw, args.count, args.start_bit, args.id_prefix, args.all_test, args.end_bit), 'Replay mismatch'
    result['entropy'] = {k: meta[k] for k in ['url', 'retrieved_at', 'raw_sha256', 'source_claim']}
    result['entropy']['filename'] = args.entropy.name
    if args.start_bit or args.all_test:
        result['entropy'].update(bit_start=args.start_bit,bit_end=result['entropy_bits_consumed'])
    if args.end_bit is not None:
        result['entropy']['reserved_end_bit'] = args.end_bit
    result['generated_at'] = datetime.now(timezone.utc).isoformat()
    result['caveat'] = 'Synthetic keystroke process; same-profile train/cal are not independent evidence of generalization. All labels require review.'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise FileExistsError('Keep this batch immutable; use a new output path')
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'rows': len(result['rows']),
                      'entropy_bits_consumed': result['entropy_bits_consumed'],
                      'first_rows': result['rows'][:4]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
