"""Reject malformed browser uploads before any data is committed."""

from hashlib import sha256
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from ..app import create_app
from ..config import Config
from ..constants import COMPLETE, HASH, SIZE, WEB_UPLOAD_OFFSET
from ..utils.upload import Upload


@pytest.fixture
def upload_client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read')
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config['TESTING'] = True
    hash_jobs = []
    # Keep tests deterministic while checking that only valid completion schedules hashing.
    monkeypatch.setattr('bepasty.views.upload.background_compute_hash',
                        lambda storage, name: hash_jobs.append(name))
    with app.test_client() as client:
        yield app, client, hash_jobs


def create_upload(client, size):
    response = client.post('/+upload/new', json={
        'filename': 'browser.bin', 'size': size, 'type': 'application/octet-stream',
    })
    assert response.status_code == 200
    return response.json['name'], response.json['url']


def test_unlimited_upload_accepts_large_declared_size_without_preallocation(upload_client):
    app, client, _ = upload_client
    app.config['MAX_ALLOWED_FILE_SIZE'] = None
    size = 6 * 1024 ** 3 + 123
    assert client.get('/apis/rest').json['MAX_ALLOWED_FILE_SIZE'] is None
    name, url = create_upload(client, size)
    assert client.get(url).json['size'] == size
    with app.storage.open(name) as item:
        assert item.meta[SIZE] == size
        assert item.data.size == 0
    assert send_file(client, url, b'abc', f'bytes 0-2/{size}').status_code == 200
    assert client.get(url).json['uploaded_bytes'] == 3
    assert client.get(url).json['complete'] is False


@pytest.mark.parametrize('size,status', [(-1, 400), ('bad', 400), (None, 400), (101, 413)])
def test_invalid_or_oversized_metadata_leaves_no_storage(upload_client, size, status):
    app, client, _ = upload_client
    app.config['MAX_ALLOWED_FILE_SIZE'] = 100
    response = client.post('/+upload/new', json={
        'filename': 'rejected.bin', 'size': size, 'type': 'application/octet-stream',
    })
    assert response.status_code == status
    assert list(app.storage) == []


def test_native_size_limit_is_checked_before_copying_to_storage(upload_client):
    app, client, _ = upload_client
    app.config['MAX_ALLOWED_FILE_SIZE'] = 2
    response = client.post('/+upload', data={'file': (BytesIO(b'abc'), 'too-big.bin')})
    assert response.status_code == 413
    assert list(app.storage) == []


def send_file(client, url, payload, content_range=None):
    headers = {'Content-Range': content_range} if content_range else {}
    return client.post(url, data={
        'file': (BytesIO(payload), 'browser.bin', 'application/octet-stream'),
    }, headers=headers)


@pytest.mark.parametrize('payload', [b'', b'ab', b'abcd'])
def test_plain_upload_size_mismatch(upload_client, payload):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)

    response = send_file(client, url, payload)

    assert response.status_code == 400
    with app.storage.open(name) as item:
        assert item.meta[SIZE] == 3
        assert item.meta[COMPLETE] is False
        assert item.meta[HASH] == ''
        assert item.data.size == 0
    assert hash_jobs == []
    assert client.get('/' + name + '/+download').status_code == 409


@pytest.mark.parametrize('payload', [b'', b'abc'])
def test_plain_upload_exact_size(upload_client, payload):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, len(payload))

    response = send_file(client, url, payload)

    assert response.status_code == 200
    with app.storage.open(name) as item:
        assert item.meta[SIZE] == len(payload)
        assert item.meta[COMPLETE] is True
        assert item.meta[HASH] == sha256(payload).hexdigest()
        assert item.data.size == len(payload)
    assert hash_jobs == []
    download = client.get('/' + name + '/+download')
    assert download.status_code == 200
    assert download.data == payload


def test_nonempty_upload_declared_empty(upload_client):
    app, client, _ = upload_client
    name, url = create_upload(client, 0)
    assert send_file(client, url, b'a').status_code == 400
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.data.size == 0


@pytest.mark.parametrize('payload', [b'', b'ab', b'abcd'])
def test_chunk_size_mismatch(upload_client, payload):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)

    response = send_file(client, url, payload, 'bytes 0-2/3')

    assert response.status_code == 400
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.meta[HASH] == ''
        assert item.data.size == 0
    assert hash_jobs == []


def test_chunk_total_must_match_declared_size(upload_client):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)
    assert send_file(client, url, b'ab', 'bytes 0-1/2').status_code == 400
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.data.size == 0
    assert hash_jobs == []


def test_truncated_final_chunk_preserves_previous_data(upload_client):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)
    assert send_file(client, url, b'ab', 'bytes 0-1/3').status_code == 200
    assert send_file(client, url, b'', 'bytes 2-2/3').status_code == 400
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.meta[HASH] == ''
        assert item.data.read(item.data.size, 0) == b'ab'
    assert hash_jobs == []

    # The rejected request has not damaged the valid bytes or completed the item.
    assert send_file(client, url, b'c', 'bytes 2-2/3').status_code == 200
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is True
        assert item.data.read(item.data.size, 0) == b'abc'
    assert hash_jobs == [name]
    assert client.get('/' + name + '/+download').data == b'abc'


def test_upload_status_starts_at_zero(upload_client):
    app, client, _ = upload_client
    name, url = create_upload(client, 3)
    response = client.get(url)
    assert response.status_code == 200
    assert response.json == {
        'name': name, 'size': 3, 'uploaded_bytes': 0, 'complete': False, 'files': [],
    }
    assert 'no-store' in response.headers['Cache-Control']
    with app.storage.open(name) as item:
        assert item.meta[WEB_UPLOAD_OFFSET] == 0


def test_status_recovers_committed_chunk_and_final_response(upload_client):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)
    first = send_file(client, url, b'ab', 'bytes 0-1/3')
    assert first.status_code == 200
    assert first.json['uploaded_bytes'] == 2
    assert first.json['complete'] is False
    # A lost first-chunk response is reconciled against persisted server state.
    status = client.get(url)
    assert status.json['uploaded_bytes'] == 2
    assert status.json['files'] == []
    with app.storage.open(name) as item:
        assert item.meta[WEB_UPLOAD_OFFSET] == 2

    final = send_file(client, url, b'c', 'bytes 2-2/3')
    assert final.status_code == 200
    status = client.get(url)
    assert status.json['complete'] is True
    assert status.json['uploaded_bytes'] == 3
    assert status.json['files'] == final.json['files']
    assert status.json['files'][0]['name'] == name
    assert hash_jobs == [name]


@pytest.mark.parametrize('payload', [b'', b'abc'])
def test_status_recovers_complete_plain_upload(upload_client, payload):
    _, client, _ = upload_client
    name, url = create_upload(client, len(payload))
    initial = client.get(url)
    assert initial.json['complete'] is False
    assert initial.json['uploaded_bytes'] == 0
    final = send_file(client, url, payload)
    status = client.get(url)
    assert status.status_code == 200
    assert status.json['complete'] is True
    assert status.json['uploaded_bytes'] == len(payload)
    assert status.json['files'] == final.json['files']


@pytest.mark.parametrize('payload, content_range', [
    (b'c', 'bytes 2-2/3'),  # A final range does not prove earlier bytes arrived.
    (b'b', 'bytes 1-1/3'),
])
def test_out_of_order_chunk_cannot_create_holes(upload_client, payload, content_range):
    app, client, hash_jobs = upload_client
    name, url = create_upload(client, 3)
    assert send_file(client, url, payload, content_range).status_code == 409
    assert client.get(url).json['uploaded_bytes'] == 0
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.data.size == 0
    assert hash_jobs == []


def test_replayed_and_overlapping_chunks_cannot_overwrite_committed_bytes(upload_client):
    app, client, _ = upload_client
    name, url = create_upload(client, 4)
    assert send_file(client, url, b'ab', 'bytes 0-1/4').status_code == 200
    assert send_file(client, url, b'XX', 'bytes 0-1/4').status_code == 409
    assert send_file(client, url, b'XY', 'bytes 1-2/4').status_code == 409
    assert send_file(client, url, b'wxyz').status_code == 409
    assert client.get(url).json['uploaded_bytes'] == 2
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.data.read(item.data.size, 0) == b'ab'


@pytest.mark.parametrize('content_range', [None, 'bytes 0-2/3'])
def test_complete_upload_is_immutable(upload_client, content_range):
    app, client, _ = upload_client
    name, url = create_upload(client, 3)
    final = send_file(client, url, b'abc')
    assert send_file(client, url, b'XYZ', content_range).status_code == 409
    assert client.get(url).json['files'] == final.json['files']
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is True
        assert item.meta[HASH] == sha256(b'abc').hexdigest()
        assert item.data.read(item.data.size, 0) == b'abc'


def test_status_and_post_require_create_permission(upload_client):
    app, client, _ = upload_client
    app.config['PASSWORDLESS'] = False
    _, url = create_upload(client, 3)
    app.config['DEFAULT_PERMISSIONS'] = 'read'
    assert client.get(url).status_code == 403
    assert send_file(client, url, b'abc').status_code == 403


def test_unknown_upload_status_and_post_are_not_found(upload_client):
    _, client, _ = upload_client
    assert client.get('/+upload/aaaaaaaa').status_code == 404
    assert send_file(client, '/+upload/aaaaaaaa', b'a').status_code == 404


def test_legacy_incomplete_item_does_not_infer_offset_from_file_length(upload_client):
    app, client, _ = upload_client
    name, url = create_upload(client, 3)
    with app.storage.openwrite(name) as item:
        del item.meta[WEB_UPLOAD_OFFSET]
        item.data.write(b'???', 0)
    status = client.get(url)
    assert status.json['uploaded_bytes'] == 0
    assert status.json['complete'] is False
    assert status.json['files'] == []
    assert send_file(client, url, b'ab', 'bytes 0-1/3').status_code == 200
    with app.storage.open(name) as item:
        assert item.data.read(item.data.size, 0) == b'ab'
    assert send_file(client, url, b'c', 'bytes 2-2/3').status_code == 200
    assert client.get('/' + name + '/+download').data == b'abc'


def test_legacy_complete_item_returns_completed_result(upload_client):
    app, client, _ = upload_client
    name, url = create_upload(client, 3)
    final = send_file(client, url, b'abc')
    with app.storage.openwrite(name) as item:
        del item.meta[WEB_UPLOAD_OFFSET]
    status = client.get(url)
    assert status.json['uploaded_bytes'] == 3
    assert status.json['complete'] is True
    assert status.json['files'] == final.json['files']


def test_unconfirmed_partial_write_cannot_advance_status(upload_client, monkeypatch):
    app, client, _ = upload_client
    name, url = create_upload(client, 4)
    assert send_file(client, url, b'ab', 'bytes 0-1/4').status_code == 200
    write_data = Upload.data

    def fail_during_write(item, stream, size, offset=0):
        item.data.write(b'?', offset)
        raise OSError('simulated write failure')

    monkeypatch.setattr(Upload, 'data', fail_during_write)
    with pytest.raises(OSError, match='simulated write failure'):
        send_file(client, url, b'cd', 'bytes 2-3/4')
    assert client.get(url).json['uploaded_bytes'] == 2
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is False
        assert item.meta[WEB_UPLOAD_OFFSET] == 2
    monkeypatch.setattr(Upload, 'data', write_data)
    assert send_file(client, url, b'cd', 'bytes 2-3/4').status_code == 200
    assert client.get('/' + name + '/+download').data == b'abcd'


def test_status_waits_for_inflight_chunk_and_then_reports_committed_offset(upload_client, monkeypatch):
    app, client, _ = upload_client
    _, url = create_upload(client, 3)
    writing, release, querying, query_finished = Event(), Event(), Event(), Event()
    original_write = Upload.data

    def blocked_write(item, stream, size, offset=0):
        writing.set()
        assert release.wait(5)
        return original_write(item, stream, size, offset)

    monkeypatch.setattr(Upload, 'data', blocked_write)

    def save_chunk():
        with app.test_client() as concurrent_client:
            return send_file(concurrent_client, url, b'ab', 'bytes 0-1/3')

    def query_status():
        querying.set()
        with app.test_client() as concurrent_client:
            response = concurrent_client.get(url)
        query_finished.set()
        return response

    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(save_chunk)
        try:
            assert writing.wait(5)
            querying_status = pool.submit(query_status)
            assert querying.wait(5)
            assert not query_finished.wait(0.1)
        finally:
            release.set()
        assert saving.result(timeout=5).status_code == 200
        status = querying_status.result(timeout=5)
    assert status.json['uploaded_bytes'] == 2
    assert status.json['complete'] is False


def test_concurrent_duplicate_chunk_rechecks_offset_after_first_commit(upload_client, monkeypatch):
    app, client, _ = upload_client
    name, url = create_upload(client, 4)
    writing, release, second_request, second_write = Event(), Event(), Event(), Event()
    original_write = Upload.data

    def blocked_first_write(item, stream, size, offset=0):
        if not writing.is_set():
            writing.set()
            assert release.wait(5)
        else:
            second_write.set()
        return original_write(item, stream, size, offset)

    monkeypatch.setattr(Upload, 'data', blocked_first_write)

    def save_chunk(payload, is_second=False):
        if is_second:
            second_request.set()
        with app.test_client() as concurrent_client:
            return send_file(concurrent_client, url, payload, 'bytes 0-1/4')

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(save_chunk, b'ab')
        try:
            assert writing.wait(5)
            second = pool.submit(save_chunk, b'XX', True)
            assert second_request.wait(5)
            assert not second_write.wait(0.1)
        finally:
            release.set()
        assert first.result(timeout=5).status_code == 200
        assert second.result(timeout=5).status_code == 409
    with app.storage.open(name) as item:
        assert item.meta[WEB_UPLOAD_OFFSET] == 2
        assert item.data.read(item.data.size, 0) == b'ab'


@pytest.mark.parametrize('payload, content_range, abort_status', [
    (b'ab', 'bytes 0-1/3', 200),
    (b'abc', 'bytes 0-2/3', 409),
])
def test_cancel_waits_for_inflight_save_and_preserves_completed_upload(
        upload_client, monkeypatch, payload, content_range, abort_status):
    app, client, _ = upload_client
    name, url = create_upload(client, 3)
    writing, release, cancelling, cancelled = Event(), Event(), Event(), Event()
    original_write = Upload.data

    def blocked_write(item, stream, size, offset=0):
        writing.set()
        assert release.wait(5)
        return original_write(item, stream, size, offset)

    monkeypatch.setattr(Upload, 'data', blocked_write)

    def save_chunk():
        with app.test_client() as concurrent_client:
            return send_file(concurrent_client, url, payload, content_range)

    def cancel():
        cancelling.set()
        with app.test_client() as concurrent_client:
            response = concurrent_client.get(url + '/abort')
        cancelled.set()
        return response

    with ThreadPoolExecutor(max_workers=2) as pool:
        saving = pool.submit(save_chunk)
        try:
            assert writing.wait(5)
            cancelling_request = pool.submit(cancel)
            assert cancelling.wait(5)
            assert not cancelled.wait(0.1)
        finally:
            release.set()
        assert saving.result(timeout=5).status_code == 200
        assert cancelling_request.result(timeout=5).status_code == abort_status
    if abort_status == 200:
        assert client.get(url).status_code == 404
    else:
        assert client.get(url).json['complete'] is True
        assert client.get('/' + name + '/+download').data == payload
