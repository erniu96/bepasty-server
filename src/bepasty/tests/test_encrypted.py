from io import BytesIO
from html.parser import HTMLParser

import pytest
from ..app import create_app
from ..config import Config


@pytest.fixture
def encrypted_client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'PASSWORDLESS', True)
    app = create_app()
    app.config['TESTING'] = True
    return app, app.test_client()


def test_encrypted_item_stays_opaque(encrypted_client):
    app, client = encrypted_client
    cipher = b'BEPAENC1' + bytes(range(64))
    result = client.post('/+upload', data={
        'file': (BytesIO(cipher), 'encrypted.bepenc', 'application/x-bepasty-encrypted'),
        'maxlife-preset': 'hours:1',
    }, headers={'Accept': 'application/json'})
    assert result.status_code == 201
    name = result.json['name']
    with app.storage.open(name) as item:
        assert item.meta['type'] == 'application/x-bepasty-encrypted'
        assert item.data.read(item.data.size, 0) == cipher
        assert not item.meta.get('auto-title-pending')
    page = client.get('/' + name)
    assert page.status_code == 200
    assert page.headers['Cache-Control'] == 'no-store'
    assert 'id="encrypted-unlock"' in page.text
    assert 'id="decrypted-download"' in page.text
    assert 'ciphertext=1' in page.text
    for suffix in ['+download', '+inline', '+thumbnail']:
        response = client.get('/' + name + '/' + suffix)
        assert response.status_code == 302
        assert response.headers['Location'].endswith('/' + name)
    response = client.get('/' + name + '/+download?ciphertext=1')
    assert response.status_code == 200
    assert response.data == cipher
    assert response.headers['Cache-Control'] == 'no-store'


def test_encryption_inputs_never_native_submit(encrypted_client):
    _, client = encrypted_client

    class Inputs(HTMLParser):
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if attrs.get('id', '').startswith('encrypt-'):
                assert 'name' not in attrs
    Inputs().feed(client.get('/').text)


def test_plain_upload_unchanged(encrypted_client):
    _, client = encrypted_client
    name = client.post('/+upload', data={'text': 'plain', 'filename': 'a.txt'},
                       headers={'Accept': 'application/json'}).json['name']
    assert 'id="encrypted-unlock"' not in client.get('/' + name).text
    assert client.get('/' + name + '/+download').data == b'plain'


def test_encryption_is_one_shared_option(encrypted_client):
    _, client = encrypted_client
    page = client.get('/').text
    assert 'id="encrypt-enabled" type="checkbox"' in page
    assert page.count('id="encrypt-password"') == 1
    assert 'id="encrypt-confirm"' not in page
    assert 'id="encrypted-upload"' not in page
    assert 'id="encrypt-file"' not in page
    assert 'id="encrypt-text"' not in page
    assert 'id="fileupload"' in page
    assert 'id="formupload"' in page
