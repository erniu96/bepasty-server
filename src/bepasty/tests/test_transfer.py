import hashlib
from io import BytesIO

import pytest

from bepasty.constants import TIMESTAMP_DOWNLOAD
from bepasty.storage.filesystem import Storage
from bepasty.utils.upload import Upload
from bepasty.views.download import DownloadView


PAYLOAD = bytes(range(256)) * 3073


@pytest.fixture
def stored_item(tmp_path):
    storage = Storage(str(tmp_path))
    with storage.create('transfer', len(PAYLOAD)) as item:
        item.data.write(PAYLOAD, 0)
        item.meta[TIMESTAMP_DOWNLOAD] = 0
    return storage


@pytest.mark.parametrize('begin, limit', [
    (0, len(PAYLOAD)),
    (17, 700001),
    (262139, 262149),
    (len(PAYLOAD) - 1, len(PAYLOAD)),
    (0, 0),
])
def test_download_range(stored_item, begin, limit):
    item = stored_item.openwrite('transfer')
    assert b''.join(DownloadView().stream(item, begin, limit)) == PAYLOAD[begin:limit]
    assert item.data._file.closed
    assert item.meta._file.closed
    with stored_item.open('transfer') as item:
        assert item.meta[TIMESTAMP_DOWNLOAD] > 0


def test_download_interrupted(stored_item):
    item = stored_item.openwrite('transfer')
    stream = DownloadView().stream(item, 0, len(PAYLOAD))
    first = next(stream)
    assert PAYLOAD.startswith(first)
    assert len(first) < len(PAYLOAD)
    stream.close()
    assert item.data._file.closed
    assert item.meta._file.closed
    with stored_item.open('transfer') as item:
        assert item.meta[TIMESTAMP_DOWNLOAD] == 0


def test_download_truncated(stored_item):
    item = stored_item.openwrite('transfer')
    stream = DownloadView().stream(item, len(PAYLOAD) - 1, len(PAYLOAD) + 1)
    assert next(stream) == PAYLOAD[-1:]
    with pytest.raises(OSError, match='Unexpected end'):
        next(stream)
    assert item.data._file.closed
    assert item.meta._file.closed
    with stored_item.open('transfer') as item:
        assert item.meta[TIMESTAMP_DOWNLOAD] == 0


class ShortReader(BytesIO):
    def read(self, size):
        return super().read(min(size, 10003))


@pytest.mark.parametrize('reader', [BytesIO, ShortReader])
def test_upload_offset_and_hash(stored_item, reader):
    payload = PAYLOAD[13:700001]
    with stored_item.openwrite('transfer') as item:
        # Read only the declared length, preserving the bytes around the range.
        written, digest = Upload.data(item, reader(payload + b'ignored'), len(payload), offset=17)
        assert written == len(payload)
        assert digest == hashlib.sha256(payload).hexdigest()
        assert item.data.read(len(PAYLOAD), 0) == PAYLOAD[:17] + payload + PAYLOAD[17 + len(payload):]


def test_upload_truncated(stored_item):
    with stored_item.openwrite('transfer') as item:
        with pytest.raises(RuntimeError):
            Upload.data(item, BytesIO(b'abc'), 4)


def test_upload_empty(stored_item):
    with stored_item.openwrite('transfer') as item:
        assert Upload.data(item, BytesIO(b'ignored'), 0) == (0, hashlib.sha256(b'').hexdigest())
        assert item.data.read(len(PAYLOAD), 0) == PAYLOAD
