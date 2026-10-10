"""Compare storage transfer loops without a web server or network.

Loads the real filesystem Storage/Data implementation and extracts the existing
upload/download loops via AST. Only their block-size literal is replaced in the
in-memory compiled function. The repository is never edited.
"""

import argparse
import ast
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import statistics
import tempfile
import time


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', help='scratch directory on the filesystem to benchmark')
parser.add_argument('--size-mib', type=int, default=256)
parser.add_argument('--repeats', type=int, default=7)
parser.add_argument('--sync-after', action='store_true', help='fsync after verification, outside the timing')
args = parser.parse_args()
if args.size_mib < 1 or args.repeats < 1:
    parser.error('size-mib and repeats must be positive')

REPO = Path(__file__).resolve().parents[1]
N = args.size_mib * 1024 * 1024 + 1234
REPEATS = args.repeats
BLOCKS = (16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024)
SYNC_AFTER = args.sync_after


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


filesystem = load_module('bench_filesystem', REPO / 'src/bepasty/storage/filesystem/__init__.py')
hashing = load_module('bench_hashing', REPO / 'src/bepasty/utils/hashing.py')


def extract_method(path, class_name, method_name):
    tree = ast.parse(path.read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == method_name)
    method.decorator_list = []

    class ReplaceBlock(ast.NodeTransformer):
        def visit_BinOp(self, node):
            if (isinstance(node.op, ast.Mult) and isinstance(node.left, ast.Constant)
                    and node.left.value in (16, 64, 256, 1024) and isinstance(node.right, ast.Constant)
                    and node.right.value == 1024):
                return ast.copy_location(ast.Name(id='CHUNK', ctx=ast.Load()), node)
            return self.generic_visit(node)
    method = ReplaceBlock().visit(method)
    module = ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[]))
    env = {'hash_new': hashlib.sha256, 'time': time, 'TIMESTAMP_DOWNLOAD': 'timestamp-download'}
    exec(compile(module, str(path), 'exec'), env)
    return env[method_name], env


upload, upload_env = extract_method(REPO / 'src/bepasty/utils/upload.py', 'Upload', 'data')
stream, stream_env = extract_method(REPO / 'src/bepasty/views/download.py', 'DownloadView', 'stream')


with tempfile.TemporaryDirectory(prefix='bepasty-transfer-benchmark-', dir=args.directory) as scratch:
    scratch = Path(scratch)
    source = scratch / 'source.bin'
    block = random.Random(20261003).randbytes(1024 * 1024)
    with source.open('wb') as f:
        remaining = N
        while remaining:
            take = min(remaining, len(block))
            f.write(block[:take])
            remaining -= take
        if SYNC_AFTER:
            f.flush()
            os.fsync(f.fileno())
    with source.open('rb') as f:
        expected = hashlib.file_digest(f, 'sha256').hexdigest()
    storage = filesystem.Storage(scratch)
    with source.open('rb') as src, storage.create('source', N) as item:
        while data := src.read(1024 * 1024):
            item.data.write(data, item.data.size)
    with (scratch / 'source.data').open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == expected
        if SYNC_AFTER:
            os.fsync(f.fileno())

    def trial(mode, chunk):
        upload_env['CHUNK'] = chunk
        stream_env['CHUNK'] = chunk
        hashing.SIZE = chunk
        if mode == 'upload_copy_sha256':
            start = time.perf_counter()
            with source.open('rb') as src, storage.create('target', N) as item:
                count, digest = upload(item, src, N)
            elapsed = time.perf_counter() - start
            assert count == N and digest == expected
            # Verify the persisted bytes independently, outside the timing.
            with (scratch / 'target.data').open('rb') as f:
                assert hashlib.file_digest(f, 'sha256').hexdigest() == expected
                if SYNC_AFTER:
                    # Reset pending target writeback outside the timed operation.
                    os.fsync(f.fileno())
        elif mode == 'download_stream':
            start = time.perf_counter()
            item = storage.openwrite('source')
            count = sum(map(len, stream(None, item, 0, N)))
            elapsed = time.perf_counter() - start
            assert count == N
            # Check actual streamed content independently, outside the timing.
            check = hashlib.sha256()
            for buf in stream(None, storage.openwrite('source'), 0, N):
                check.update(buf)
            assert check.hexdigest() == expected
        elif mode == 'storage_sha256':
            start = time.perf_counter()
            with storage.open('source') as item:
                digest = hashing.compute_hash(item.data, N)
            elapsed = time.perf_counter() - start
            assert digest == expected
        else:
            raise AssertionError(mode)
        return elapsed

    cases = [(mode, chunk) for mode in ('upload_copy_sha256', 'download_stream', 'storage_sha256')
             for chunk in BLOCKS]
    samples = {case: [] for case in cases}
    # One discarded warm-up per case, then seven independently shuffled rounds.
    for mode, chunk in cases:
        trial(mode, chunk)
    rng = random.Random(149)
    for repeat in range(REPEATS):
        ordered = cases[:]
        rng.shuffle(ordered)
        for mode, chunk in ordered:
            samples[(mode, chunk)].append(trial(mode, chunk))
    result = {
        'bytes': N, 'repeats': REPEATS,
        'sha256': expected,
        'python': os.sys.version,
        'scratch_directory': str(scratch.parent),
        'limits': 'Warm page cache; buffered writes including close, no fsync; no HTTP, WSGI server, TLS or network.',
        'fsync_after_timing': SYNC_AFTER,
        'results': [],
    }
    for (mode, chunk), timings in samples.items():
        rates = [N / t / (1024 ** 2) for t in timings]
        result['results'].append({
            'mode': mode, 'chunk_bytes': chunk,
            'iterations': math.ceil(N / chunk),
            'median_mib_s': statistics.median(rates),
            'min_mib_s': min(rates), 'max_mib_s': max(rates),
            'seconds': timings,
        })
    print(json.dumps(result, indent=2), flush=True)
