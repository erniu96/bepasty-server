"""Benchmark Bepasty's browser upload protocol over HTTP and verify downloaded bytes.

Example (advertised default body limit is 0.9921875 MiB):
    python scripts/benchmark-http.py --base-url http://HOST:5000 --size-mib 32 \
        --chunk-mib 0.25 --chunk-mib 0.5 --chunk-mib 0.9921875 --repeats 3 \
        --cleanup --output results.json

This measures an HTTP client, multipart encoding, server/storage work and SHA256
verification. A client using its own host's LAN address does not exercise a
physical network link. No authentication secrets are accepted or printed.
"""

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import sys
import tempfile
import time
from urllib.parse import urljoin, urlsplit
import zlib

import requests


MIB = 1024 * 1024


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--size-mib', type=int, default=32)
    parser.add_argument('--chunk-mib', type=Decimal, action='append', required=True,
                        help='repeat this option to compare chunk sizes')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--cleanup', action='store_true',
                        help='required: delete only items created by this run')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=120)
    args = parser.parse_args()
    parsed = urlsplit(args.base_url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        parser.error('base-url must be an HTTP(S) URL without embedded credentials')
    if parsed.query or parsed.fragment:
        parser.error('base-url cannot contain a query or fragment')
    if not args.cleanup:
        parser.error('--cleanup is required before creating benchmark items')
    if args.size_mib < 1 or args.repeats < 1 or args.timeout <= 0:
        parser.error('size-mib, repeats and timeout must be positive')
    args.chunk_bytes = []
    for value in args.chunk_mib:
        size = value * MIB
        if not size.is_finite() or size <= 0 or size != int(size):
            parser.error('each chunk-mib must describe a positive whole-byte size')
        if int(size) not in args.chunk_bytes:
            args.chunk_bytes.append(int(size))
    args.base_url = args.base_url.rstrip('/') + '/'
    return args


def endpoint(base, path):
    return urljoin(base, path.lstrip('/'))


def create_source(path, size):
    digest = hashlib.sha256()
    compressor = zlib.compressobj(level=1)
    compressed_size = 0
    with path.open('wb') as output:
        remaining = size
        while remaining:
            block = os.urandom(min(MIB, remaining))
            output.write(block)
            digest.update(block)
            compressed_size += len(compressor.compress(block))
            remaining -= len(block)
    compressed_size += len(compressor.flush())
    return digest.hexdigest(), compressed_size / size


def cleanup_item(session, base, name, upload_url, completed, timeout):
    if not name:
        return {'deleted': False, 'reason': 'No item address was returned.'}
    if not completed:
        response = session.get(upload_url + '/abort', timeout=timeout, allow_redirects=False)
        if response.status_code in (200, 404):
            check = session.get(endpoint(base, 'apis/rest/items/' + name), timeout=timeout)
            return {'deleted': check.status_code == 404, 'method': 'abort',
                    'http_status': response.status_code, 'verification_http_status': check.status_code}
        if response.status_code != 409:
            return {'deleted': False, 'method': 'abort', 'http_status': response.status_code}
    response = session.post(endpoint(base, name + '/+delete'), timeout=timeout, allow_redirects=False)
    deleted = response.status_code in (200, 302, 303, 404)
    check = session.get(endpoint(base, 'apis/rest/items/' + name), timeout=timeout) if deleted else None
    return {'deleted': deleted and check.status_code == 404,
            'method': 'delete', 'http_status': response.status_code,
            'verification_http_status': check.status_code if check is not None else None}


def run_trial(session, args, source, size, expected_hash, chunk_size, repeat):
    result = {'chunk_bytes': chunk_size, 'chunk_mib': chunk_size / MIB, 'repeat': repeat}
    name = upload_url = None
    completed = False
    timeout = (10, args.timeout)
    filename = 'bepasty-http-benchmark-' + source.parent.name + '.bin'
    try:
        started = time.perf_counter()
        response = session.post(endpoint(args.base_url, '+upload/new'), json={
            'filename': filename, 'size': size, 'type': 'application/octet-stream',
            'maxlife_unit': 'minutes', 'maxlife_value': 15,
        }, timeout=timeout)
        metadata_done = time.perf_counter()
        response.raise_for_status()
        metadata = response.json()
        candidate_name = metadata['name']
        if not isinstance(candidate_name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', candidate_name):
            raise ValueError('Server returned an invalid item identifier.')
        name = candidate_name
        expected_url = endpoint(args.base_url, '+upload/' + name)
        upload_url = expected_url
        if urljoin(args.base_url, metadata['url']) != expected_url:
            raise ValueError('Server returned an unexpected upload endpoint.')
        result.update({'item_name': name, 'metadata_seconds': metadata_done - started,
                       'server': response.headers.get('Server'),
                       'response_connection': response.headers.get('Connection')})
        chunk_latencies = []
        upload_started = time.perf_counter()
        with source.open('rb') as input_file:
            offset = 0
            while offset < size:
                block = input_file.read(chunk_size)
                request_started = time.perf_counter()
                if not chunk_latencies:
                    result['first_upload_request_start_seconds'] = request_started - started
                response = session.post(
                    upload_url,
                    files={'file': (filename, block, 'application/octet-stream')},
                    headers={'Content-Range': 'bytes {}-{}/{}'.format(offset, offset + len(block) - 1, size)},
                    timeout=timeout)
                request_done = time.perf_counter()
                response.raise_for_status()
                payload = response.json()
                uploaded_file = payload['files'][0]
                if uploaded_file['name'] != name or uploaded_file['size'] != size:
                    raise ValueError('Server response does not match the current benchmark item.')
                chunk_latencies.append(request_done - request_started)
                offset += len(block)
        completed = True
        upload_done = time.perf_counter()
        result.update({
            'chunk_count': len(chunk_latencies),
            'first_chunk_seconds': chunk_latencies[0],
            'first_chunk_completed_seconds': result['first_upload_request_start_seconds'] + chunk_latencies[0],
            'chunk_request_median_seconds': statistics.median(chunk_latencies),
            'upload_seconds': upload_done - started,
            'upload_payload_seconds': upload_done - upload_started,
            'upload_mib_s': size / MIB / (upload_done - started),
            'upload_payload_mib_s': size / MIB / (upload_done - upload_started),
        })
        download_started = time.perf_counter()
        digest = hashlib.sha256()
        downloaded = 0
        with session.get(endpoint(args.base_url, name + '/+download'), stream=True,
                         headers={'Accept-Encoding': 'identity'}, timeout=timeout) as response:
            headers_received = time.perf_counter()
            response.raise_for_status()
            if response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ValueError('The download used a content encoding despite requesting identity.')
            for block in response.iter_content(chunk_size=256 * 1024):
                digest.update(block)
                downloaded += len(block)
        done = time.perf_counter()
        actual_hash = digest.hexdigest()
        result.update({
            'download_header_seconds': headers_received - download_started,
            'download_seconds': done - download_started,
            'download_mib_s': downloaded / MIB / (done - download_started),
            'downloaded_bytes': downloaded,
            'download_sha256': actual_hash,
            'sha256_verified': actual_hash == expected_hash and downloaded == size,
            'total_seconds': done - started,
        })
        if not result['sha256_verified']:
            raise ValueError('Downloaded length or SHA256 differs from the source.')
    except (requests.RequestException, ValueError, KeyError, IndexError) as error:
        result['error'] = str(error)
    finally:
        try:
            result['cleanup'] = cleanup_item(session, args.base_url, name, upload_url, completed, timeout)
        except requests.RequestException as error:
            result['cleanup'] = {'deleted': False, 'reason': str(error)}
    return result


def main():
    args = arguments()
    report = {
        'started_at_utc': datetime.now(timezone.utc).isoformat(),
        'base_url': args.base_url,
        'size_bytes': args.size_mib * MIB,
        'repeats': args.repeats,
        'session_reused': True,
        'environment_proxies_disabled': True,
        'measurement_scope': ('HTTP via an explicitly supplied address; '
                              'same-host LAN-address runs do not measure physical link capacity.'),
        'timing_notes': {
            'upload_seconds': ('Metadata POST start through final sequential multipart chunk response; '
                               'includes client read/encoding and server work.'),
            'download_seconds': ('GET start through streamed response consumption and client SHA256; '
                                 'includes hash verification.'),
            'rtt_proxy_seconds': ('Small public /apis/rest GET request/response latency, '
                                  'not ICMP or isolated network RTT.'),
            'source_generation_and_cleanup': 'Outside transfer timings.',
        },
        'trials': [],
    }
    failed = False
    with requests.Session() as session:
        session.trust_env = False
        response = session.get(endpoint(args.base_url, 'apis/rest'), timeout=(10, args.timeout))
        response.raise_for_status()
        limits = response.json()
        file_limit = limits['MAX_ALLOWED_FILE_SIZE']
        report['server_limits'] = {'MAX_BODY_SIZE': int(limits['MAX_BODY_SIZE']),
                                   'MAX_ALLOWED_FILE_SIZE': None if file_limit is None else int(file_limit)}
        size = report['size_bytes']
        if file_limit is not None and size > report['server_limits']['MAX_ALLOWED_FILE_SIZE']:
            raise SystemExit('Requested file exceeds the advertised MAX_ALLOWED_FILE_SIZE.')
        if any(chunk > report['server_limits']['MAX_BODY_SIZE'] for chunk in args.chunk_bytes):
            raise SystemExit('Requested chunk exceeds advertised MAX_BODY_SIZE={} bytes.'.format(
                report['server_limits']['MAX_BODY_SIZE']))
        latencies = []
        for _ in range(10):
            started = time.perf_counter()
            response = session.get(endpoint(args.base_url, 'apis/rest'), timeout=(10, args.timeout))
            response.raise_for_status()
            latencies.append(time.perf_counter() - started)
        report['rtt_proxy_seconds'] = {
            'samples': latencies, 'median': statistics.median(latencies),
            'min': min(latencies), 'max': max(latencies),
        }
        with tempfile.TemporaryDirectory(prefix='bepasty-http-benchmark-') as temporary:
            if shutil.disk_usage(temporary).free < size * 2 + 10 * MIB:
                raise SystemExit('Insufficient free space for the bounded benchmark.')
            source = Path(temporary) / 'random.bin'
            expected_hash, ratio = create_source(source, size)
            report['source_sha256'] = expected_hash
            report['source_zlib_level1_ratio'] = ratio
            for repeat in range(1, args.repeats + 1):
                for chunk_size in args.chunk_bytes:
                    trial = run_trial(session, args, source, size, expected_hash, chunk_size, repeat)
                    report['trials'].append(trial)
                    print(json.dumps({key: trial.get(key) for key in (
                        'repeat', 'chunk_mib', 'upload_mib_s', 'download_mib_s',
                        'sha256_verified', 'cleanup', 'error')}),
                        file=sys.stderr, flush=True)
                    if trial.get('error') or not trial['cleanup']['deleted']:
                        failed = True
                        break
                if failed:
                    break
    report['summary'] = []
    for chunk_size in args.chunk_bytes:
        trials = [trial for trial in report['trials'] if trial['chunk_bytes'] == chunk_size and
                  trial.get('sha256_verified') and trial['cleanup']['deleted']]
        if trials:
            report['summary'].append({
                'chunk_bytes': chunk_size, 'chunk_mib': chunk_size / MIB,
                'verified_trials': len(trials), **{
                    key: statistics.median(trial[key] for trial in trials)
                    for key in ('metadata_seconds', 'first_chunk_seconds', 'upload_seconds',
                                'upload_mib_s', 'download_seconds', 'download_mib_s', 'total_seconds')
                },
            })
    report['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
    report['successful'] = not failed
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(str(args.output.resolve()))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
