"""Rename responses keep native redirects and permission enforcement."""

import pytest

from ..app import create_app
from ..config import Config
from ..constants import FILENAME, TYPE


@pytest.fixture
def rename_client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read,modify')
    monkeypatch.setattr(Config, 'PASSWORDLESS', False)
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        result = client.post('/+upload',
                             data={'text': 'unchanged',
                                   'filename': 'before.txt'},
                             headers={'Accept': 'application/json'})
        yield app, client, result.json['name']


@pytest.mark.parametrize('enhanced', [False, True])
def test_rename_response_and_persisted_metadata(rename_client, enhanced):
    app, client, name = rename_client
    headers = {'Accept': 'application/json'} if enhanced else {}
    response = client.post('/' + name + '/+modify', data={
        'filename': '中文新名称.txt', 'contenttype': 'text/plain',
    }, headers=headers)
    if enhanced:
        assert response.status_code == 200
        assert response.json['name'] == name
        assert response.json['filename'] == '中文新名称.txt'
        assert response.json['contenttype'] == 'text/plain'
    else:
        assert response.status_code == 302
        assert response.headers['Location'].endswith('/' + name)
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == '中文新名称.txt'
        assert item.meta[TYPE] == 'text/plain'
        assert item.data.read(item.data.size, 0) == b'unchanged'


def test_json_rename_still_requires_permission(rename_client):
    app, client, name = rename_client
    app.config['DEFAULT_PERMISSIONS'] = 'create,read'
    response = client.post('/' + name + '/+modify',
                           data={'filename': 'denied.txt'},
                           headers={'Accept': 'application/json'})
    assert response.status_code == 403
    with app.storage.open(name) as item:
        assert item.meta[FILENAME] == 'before.txt'
