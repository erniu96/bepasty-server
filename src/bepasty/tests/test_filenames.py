"""Preserve international file names without putting unsafe text in headers or HTML."""

from html.parser import HTMLParser
from io import BytesIO
from urllib.parse import unquote, urlsplit

import pytest

from ..app import create_app
from ..config import Config
from ..constants import FILENAME
from ..utils.http import content_disposition
from ..utils.upload import MAX_FILENAME_LENGTH, Upload


@pytest.fixture
def filename_client(tmp_path, monkeypatch):
    monkeypatch.delenv('BEPASTY_CONFIG', raising=False)
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read,modify')
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield app, client


@pytest.mark.parametrize('filename', [
    '中文文件名.txt', 'café.txt', 'cafe\u0301.txt', '😀 image.png', 'Резюме.pdf',
])
def test_filename_preserves_unicode(filename):
    assert Upload.filter_filename(filename, 'fallback', 'text/plain', '') == filename


@pytest.mark.parametrize('filename, expected', [
    ('safe<>"\'/\\\r\n\t|?\x00name.txt', 'safename.txt'),
    ('a *+:;.,_-09.txt', 'a *+:;.,_-09.txt'),
    ('\u202e中文\u2066报告\u2028\uff0f\uff3c\u200b.txt', '中文报告.txt'),
    ('中文\ud800\x85.txt', '中文.txt'),
])
def test_filename_removes_unsafe_characters(filename, expected):
    assert Upload.filter_filename(filename, 'fallback', 'text/plain', '') == expected


def test_filename_length_limit_and_generated_default():
    assert Upload.filter_filename('中' * 1000, 'fallback', 'text/plain', '') == '中' * MAX_FILENAME_LENGTH
    assert Upload.filter_filename(None, 'fallback', 'text/plain', '') == 'fallback.txt'


@pytest.mark.parametrize('filename, fallback', [
    ('中文文件名.txt', 'download.txt'),
    ('café.txt', 'cafe.txt'),
    ('😀.png', 'download.png'),
])
def test_unicode_disposition_has_legacy_fallback(filename, fallback):
    header = content_disposition('attachment', filename)
    assert header.startswith('attachment; filename="{}"; filename*=UTF-8\'\''.format(fallback))
    assert header.isascii()
    assert unquote(header.split("filename*=UTF-8''", 1)[1]) == filename


def test_ascii_disposition_stays_compatible_and_rejects_injection():
    assert content_disposition('attachment', 'test.py') == 'attachment; filename="test.py"'
    header = content_disposition('attachment', '中文"; filename="bad.txt\r\nX-Evil: yes')
    assert '\r' not in header and '\n' not in header
    assert header.count('filename="') == 1
    assert header.isascii()


def upload_file(client, filename, payload=b'file contents', content_type='text/plain'):
    response = client.post('/+upload', data={
        'file': (BytesIO(payload), filename, content_type),
    })
    assert response.status_code == 302
    path = urlsplit(response.headers['Location']).path
    return path, path.rsplit('/', 1)[-1]


@pytest.mark.parametrize('filename', ['中文文件名.txt', 'café.txt', '😀.txt'])
def test_unicode_upload_display_and_download_roundtrip(filename_client, filename):
    app, client = filename_client
    payload = '保留原始内容 😀'.encode()
    path, name = upload_file(client, filename, payload)
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == filename
    page = client.get(path)
    assert page.status_code == 200
    assert filename in page.get_data(as_text=True)

    for endpoint in (path + '/+download', path + '/+inline', '/apis/rest/items/' + name + '/download'):
        response = client.get(endpoint)
        assert response.status_code == 200
        assert response.data == payload
        header = response.headers['Content-Disposition']
        assert header.isascii()
        assert unquote(header.split("filename*=UTF-8''", 1)[1]) == filename
        fallback = header.split('filename="', 1)[1].split('"', 1)[0]
        assert fallback.endswith('.txt')
        assert fallback != '.txt'


def test_unicode_ajax_upload_roundtrip(filename_client):
    app, client = filename_client
    filename = '中文上传.txt'
    response = client.post('/+upload/new', json={'filename': filename, 'size': 3, 'type': 'text/plain'})
    assert response.status_code == 200
    response = client.post(response.json['url'], data={'file': (BytesIO(b'abc'), filename)})
    assert response.status_code == 200
    assert response.json['files'][0]['filename'] == filename
    name = response.json['files'][0]['name']
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == filename
    response = client.get('/' + name + '/+download')
    assert response.data == b'abc'
    assert unquote(response.headers['Content-Disposition'].split("filename*=UTF-8''", 1)[1]) == filename


def test_unicode_rest_rename_roundtrip(filename_client):
    _, client = filename_client
    _, name = upload_file(client, 'original.txt')
    api_path = '/apis/rest/items/' + name
    response = client.post(api_path + '/modify', json={FILENAME: '中文新文件名.txt'})
    assert response.status_code == 200
    response = client.get(api_path)
    assert response.status_code == 200
    assert response.json['file-meta'][FILENAME] == '中文新文件名.txt'
    response = client.get(api_path + '/download')
    assert response.data == b'file contents'
    assert unquote(response.headers['Content-Disposition'].split("filename*=UTF-8''", 1)[1]) == '中文新文件名.txt'


def test_unicode_placeholder_thumbnail_header(filename_client):
    _, client = filename_client
    path, _ = upload_file(client, '中文文件名.txt')
    response = client.get(path + '/+thumbnail')
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'image/svg+xml'
    header = response.headers['Content-Disposition']
    assert header.startswith('inline; filename="') and header.isascii()
    assert unquote(header.split("filename*=UTF-8''", 1)[1]) == '中文文件名-thumb.svg'


def test_unicode_image_thumbnail_header(filename_client):
    Image = pytest.importorskip('PIL.Image')
    _, client = filename_client
    data = BytesIO()
    Image.new('RGB', (24, 16)).save(data, 'PNG')
    path, _ = upload_file(client, '中文图片.png', data.getvalue(), 'image/png')
    response = client.get(path + '/+thumbnail')
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'image/png'
    header = response.headers['Content-Disposition']
    assert header.isascii()
    assert unquote(header.split("filename*=UTF-8''", 1)[1]) == '中文图片-thumb.png'
    with Image.open(BytesIO(response.data)) as thumbnail:
        assert thumbnail.size == (24, 16)


class PlayerParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.players = []

    def handle_starttag(self, tag, attrs):
        if tag == 'asciinema-player':
            self.players.append(dict(attrs))


def test_asciinema_title_escapes_existing_unsafe_metadata(filename_client):
    app, client = filename_client
    path, name = upload_file(client, '中文.cast', b'{}', 'application/x-asciinema-recording')
    unsafe = '中文" onmouseover="alert(1)"><script>alert(2)</script>'
    # Old/custom storage metadata must also be safe at the point of rendering.
    with app.storage.openwrite(name) as item:
        item.meta[FILENAME] = unsafe
    response = client.get(path)
    assert response.status_code == 200
    parser = PlayerParser()
    html = response.get_data(as_text=True)
    parser.feed(html)
    assert len(parser.players) == 1
    assert parser.players[0]['title'] == unsafe
    assert 'onmouseover' not in parser.players[0]
    assert '<script>alert(2)</script>' not in html
