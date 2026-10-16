"""Trusted-network access works without passwords, session keys or old credentials."""

import base64
from io import BytesIO
from urllib.parse import urlsplit

import pytest

from ..app import create_app
from ..config import Config
from ..constants import COMPLETE, FILENAME, LOCKED
from ..utils.permissions import (
    ADMIN, CREATE, DELETE, LIST, LOGGEDIN, MODIFY, PERMISSIONS, READ,
    get_permissions, logged_in,
)


@pytest.fixture
def passwordless_client(tmp_path, monkeypatch):
    monkeypatch.delenv('BEPASTY_CONFIG', raising=False)
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', '')
    monkeypatch.setattr(Config, 'PERMISSIONS', {'restricted': 'read'})
    monkeypatch.setattr(Config, 'SECRET_KEY', '')
    # These tests exercise the default, rather than enabling it in the fixture.
    assert Config.PASSWORDLESS is True
    app = create_app()
    app.config['TESTING'] = True
    monkeypatch.setattr('bepasty.apis.rest.background_compute_hash', lambda storage, name: None)
    monkeypatch.setattr('bepasty.views.upload.background_compute_hash', lambda storage, name: None)
    with app.test_client() as client:
        yield app, client


def native_upload(client, payload=b'file contents', **kwargs):
    data = {'file': (BytesIO(payload), 'lan.txt', 'text/plain')}
    data.update(kwargs.pop('form', {}))
    response = client.post('/+upload', data=data, **kwargs)
    assert response.status_code == 302
    path = urlsplit(response.headers['Location']).path
    return path, path.rsplit('/', 1)[-1]


def test_default_access_requires_no_session_secret(passwordless_client):
    app, client = passwordless_client
    assert app.config['PASSWORDLESS'] is True
    assert app.config['SECRET_KEY'] == ''
    for path in ('/', '/+list', '/apis/rest/items'):
        response = client.get(path)
        assert response.status_code == 200
        assert 'Set-Cookie' not in response.headers
    with app.test_request_context('/'):
        assert get_permissions() == {ADMIN, CREATE, DELETE, LIST, MODIFY, READ}
        assert logged_in() is False


@pytest.mark.parametrize('endpoint', ['/+login', '/+logout'])
def test_login_and_logout_are_disabled(passwordless_client, endpoint):
    _, client = passwordless_client
    response = client.post(endpoint, data={'token': 'restricted'})
    assert response.status_code == 404
    assert 'Set-Cookie' not in response.headers
    assert client.get('/+list').status_code == 200


@pytest.mark.parametrize('credential', [
    'basic-restricted', 'basic-unknown', 'query-restricted', 'query-unknown',
    'form-restricted', 'form-unknown', 'old-session',
])
def test_old_credentials_cannot_reduce_access(passwordless_client, credential):
    app, client = passwordless_client
    request_kwargs = {}
    upload_kwargs = {}
    if credential.startswith('basic-'):
        token = credential.split('-', 1)[1]
        auth = base64.b64encode(('user:' + token).encode()).decode()
        request_kwargs['headers'] = {'Authorization': 'Basic ' + auth}
        upload_kwargs.update(request_kwargs)
    elif credential.startswith('query-'):
        request_kwargs['query_string'] = {'token': credential.split('-', 1)[1]}
        upload_kwargs.update(request_kwargs)
    elif credential.startswith('form-'):
        upload_kwargs['form'] = {'token': credential.split('-', 1)[1]}
    else:
        # Model an already signed cookie from before passwordless mode was enabled.
        app.config['SECRET_KEY'] = 'test-only-old-session-key'
        with client.session_transaction() as old_session:
            old_session[PERMISSIONS] = ''
            old_session[LOGGEDIN] = True

    payload = '无需密码'.encode()
    path, name = native_upload(client, payload, **upload_kwargs)
    response = client.get('/apis/rest/items', **request_kwargs)
    assert response.status_code == 200
    assert name in response.json
    response = client.get(path + '/+download', **request_kwargs)
    assert response.status_code == 200
    assert response.data == payload
    assert 'Set-Cookie' not in response.headers


@pytest.mark.parametrize('payload', [b'', '无 JavaScript 表单上传'.encode()])
def test_anonymous_native_upload_roundtrip(passwordless_client, payload):
    app, client = passwordless_client
    path, name = native_upload(client, payload)
    with app.storage.open(name) as item:
        assert item.meta[COMPLETE] is True
    assert client.get(path).status_code == 200
    response = client.get(path + '/+download')
    assert response.status_code == 200
    assert response.data == payload
    assert client.get('/+list').status_code == 200
    assert name in client.get('/apis/rest/items').json


def test_existing_locked_items_remain_accessible(passwordless_client):
    app, client = passwordless_client
    path, name = native_upload(client)
    # Existing deployments may already contain files locked by their former admin.
    with app.storage.openwrite(name) as item:
        item.meta[LOCKED] = True
    assert client.get(path).status_code == 200
    for endpoint in (path + '/+download', path + '/+inline',
                     '/apis/rest/items/' + name + '/download'):
        response = client.get(endpoint)
        assert response.status_code == 200
        assert response.data == b'file contents'
    assert client.post(path + '/+modify', data={'filename': 'renamed.txt'}).status_code == 302
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == 'renamed.txt'
        assert item.meta[LOCKED] is True
    assert client.post(path + '/+unlock').status_code == 302
    assert client.post(path + '/+lock').status_code == 302
    assert client.post(path + '/+delete').status_code == 302
    assert client.get(path).status_code == 404


def test_anonymous_web_upload_resume(passwordless_client):
    _, client = passwordless_client
    new = client.post('/+upload/new', json={
        'filename': 'resume.txt', 'type': 'text/plain', 'size': 3,
    })
    assert new.status_code == 200
    url = new.json['url']
    assert client.get(url).json['uploaded_bytes'] == 0
    for payload, content_range, offset in ((b'ab', 'bytes 0-1/3', 2), (b'c', 'bytes 2-2/3', 3)):
        response = client.post(url, data={'file': (BytesIO(payload), 'resume.txt')},
                               headers={'Content-Range': content_range})
        assert response.status_code == 200
        assert client.get(url).json['uploaded_bytes'] == offset
    assert client.get(url).json['complete'] is True
    assert client.get('/' + new.json['name'] + '/+download').data == b'abc'


def test_cli_rest_upload_works_with_or_without_old_password(passwordless_client):
    _, client = passwordless_client
    payload = b'CLI upload'
    for token in (None, 'restricted', 'unknown'):
        headers = {'Content-Type': 'application/octet-stream', 'Content-Filename': 'cli.bin',
                   'Content-Range': 'bytes 0-9/10'}
        if token:
            headers['Authorization'] = 'Basic ' + base64.b64encode(('user:' + token).encode()).decode()
        response = client.post('/apis/rest/items', data=base64.b64encode(payload), headers=headers)
        assert response.status_code == 201
        location = response.headers['Content-Location']
        response = client.get(location + '/download', headers=headers)
        assert response.status_code == 200
        assert response.data == payload


def test_optional_password_mode_still_enforces_permissions(passwordless_client):
    app, client = passwordless_client
    app.config.update(PASSWORDLESS=False, SECRET_KEY='test-only-login-key',
                      SESSION_COOKIE_SECURE=False,
                      PERMISSIONS={'uploader': 'create,read', 'restricted': 'read'})
    page = client.get('/').get_data(as_text=True)
    assert 'action="/+login"' in page
    assert 'name="token"' in page
    assert client.get('/+list').status_code == 403
    assert client.post('/+upload', data={'text': 'anonymous', 'filename': 'anonymous.txt'}).status_code == 403
    assert client.post('/+login', data={'token': 'uploader'}).status_code == 302
    page = client.get('/').get_data(as_text=True)
    assert 'action="/+logout"' in page
    assert 'action="/+login"' not in page
    path, _ = native_upload(client)
    assert client.get(path + '/+download').data == b'file contents'
    assert client.get('/+list').status_code == 403
    assert client.post('/+logout').status_code == 302
    assert client.get(path + '/+download').status_code == 403
