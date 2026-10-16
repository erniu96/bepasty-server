"""The upload page must work as an ordinary HTML form without JavaScript."""

from hashlib import sha256
from html.parser import HTMLParser
from io import BytesIO
import time
from urllib.parse import urlsplit

import pytest

from ..app import create_app
from ..config import Config
from ..constants import COMPLETE, FILENAME, HASH, SIZE, TIMESTAMP_MAX_LIFE, TYPE


class UploadFormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.form = None
        self.upload_form = None
        self.file_input = None
        self.upload_button = None
        self.in_noscript = False
        self.in_style = False
        self.noscript_css = ''

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'form':
            self.form = attrs
        elif tag == 'noscript':
            self.in_noscript = True
        elif tag == 'style':
            self.in_style = True
        elif tag == 'input' and attrs.get('id') == 'fileupload':
            self.file_input = attrs
            self.upload_form = self.form
        elif tag == 'button' and attrs.get('id') == 'fileupload-submit':
            self.upload_button = attrs
            assert not self.in_noscript
            assert self.form == self.upload_form

    def handle_endtag(self, tag):
        if tag == 'form':
            self.form = None
        elif tag == 'noscript':
            self.in_noscript = False
        elif tag == 'style':
            self.in_style = False

    def handle_data(self, data):
        if self.in_noscript and self.in_style:
            self.noscript_css += data


@pytest.fixture
def fallback_client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read')
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield app, client


def parse_upload_form(client):
    response = client.get('/')
    assert response.status_code == 200
    parser = UploadFormParser()
    parser.feed(response.get_data(as_text=True))
    return parser


def test_upload_form_available_without_javascript(fallback_client):
    _, client = fallback_client
    page = parse_upload_form(client)

    assert page.upload_form['method'].upper() == 'POST'
    assert page.upload_form['enctype'] == 'multipart/form-data'
    assert page.file_input['name'] == 'file'
    # The ordinary endpoint accepts one file; multiple selection is an enhancement.
    assert 'multiple' not in page.file_input
    assert 'disabled' not in page.file_input
    assert page.upload_button['type'] == 'submit'
    assert 'hidden' not in page.upload_button
    assert 'display: none' not in page.upload_button.get('style', '')
    assert 'disabled' not in page.upload_button


def test_primary_navigation_needs_no_javascript(fallback_client):
    _, client = fallback_client
    page = client.get('/').get_data(as_text=True)
    assert 'aria-label="主导航"' in page
    assert 'data-toggle="collapse"' not in page
    # Optional item encryption has password fields, but no login is required.
    assert 'action="/+login"' not in page
    assert 'name="password"' not in page
    assert 'autofocus' not in page
    assert '>上传</a>' in page
    assert '>列表</a>' in page
    assert '<details' not in page
    assert 'id="text-maxlife-preset"' in page
    assert 'id="formupload"' in page


@pytest.mark.parametrize('kind', ['file', 'text'])
def test_native_forms_use_retention_preset(fallback_client, kind):
    app, client = fallback_client
    before = int(time.time())
    data = {'maxlife-preset': 'hours:2'}
    if kind == 'file':
        data['file'] = (BytesIO(b'preset'), 'preset.txt')
    else:
        data.update(text='preset', filename='preset.txt')
    response = client.post('/+upload', data=data)
    assert response.status_code == 302
    name = urlsplit(response.headers['Location']).path.lstrip('/')
    with app.storage.open(name) as item:
        assert before + 7200 <= item.meta[TIMESTAMP_MAX_LIFE] <= int(time.time()) + 7200


@pytest.mark.parametrize('filename,text', [
    ('', '中文笔记\n第二行 🎉'),
    ('a & <script>.txt', ''),
])
def test_workspace_text_result_uses_stored_filename_and_bytes(fallback_client, filename, text):
    app, client = fallback_client
    response = client.post('/+upload', data={
        'filename': filename, 'text': text, 'maxlife-preset': 'hours:2',
    }, headers={'Accept': 'application/json'})
    assert response.status_code == 201
    result = response.json
    assert result['complete'] is True
    assert result['uploaded_bytes'] == result['size'] == len(text.encode('utf-8'))
    file = result['files'][0]
    assert file['name'] == result['name']
    assert file['size'] == result['size']
    with app.storage.open(result['name']) as item:
        assert file['filename'] == item.meta[FILENAME]
        assert item.data.read(item.data.size, 0) == text.encode('utf-8')
        assert item.meta[HASH] == sha256(text.encode('utf-8')).hexdigest()
    assert urlsplit(file['url']).path == '/' + result['name']
    assert not urlsplit(file['url']).scheme, 'the browser retains its actual HTTP/HTTPS origin'


def test_workspace_collection_keeps_native_upload_contract(fallback_client):
    app, client = fallback_client
    names = []
    for text in ('one', 'two'):
        response = client.post('/+upload', data={'text': text}, headers={'Accept': 'application/json'})
        names.append(response.json['name'])
    response = client.post('/+upload', data={
        'filename': '文件集合', 'contenttype': 'text/x-bepasty-list',
        'text': '\n'.join(names) + '\n', 'maxlife-preset': 'forever:1',
    }, headers={'Accept': 'application/json'})
    assert response.status_code == 201
    with app.storage.open(response.json['name']) as item:
        assert item.meta[TYPE] == 'text/x-bepasty-list'
        assert item.meta[TIMESTAMP_MAX_LIFE] <= 0
        assert item.data.read(item.data.size, 0).decode('utf-8').splitlines() == names


@pytest.mark.parametrize('payload', [b'', bytes(range(256)) * 1024])
def test_native_upload_preserves_file_and_lifetime(fallback_client, payload):
    app, client = fallback_client
    page = parse_upload_form(client)
    before = int(time.time())
    response = client.post(page.upload_form['action'], data={
        'file': (BytesIO(payload), 'fallback.bin', 'application/octet-stream'),
        'text': '',
        'maxlife-value': '2',
        'maxlife-unit': 'hours',
    })
    after = int(time.time())

    assert response.status_code == 302
    path = urlsplit(response.headers['Location']).path
    name = path.rsplit('/', 1)[-1]
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == 'fallback.bin'
        assert item.meta[SIZE] == len(payload)
        assert item.meta[TYPE] == 'application/octet-stream'
        assert item.meta[COMPLETE] is True
        assert item.meta[HASH] == sha256(payload).hexdigest()
        assert before + 7200 <= item.meta[TIMESTAMP_MAX_LIFE] <= after + 7200

    download = client.get(path + '/+download')
    assert download.status_code == 200
    assert download.data == payload
    assert download.headers['Content-Length'] == str(len(payload))
