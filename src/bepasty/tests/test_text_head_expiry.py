import time
import pytest
from ..app import create_app
from ..config import Config


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'PASSWORDLESS', True)
    app = create_app()
    app.config['TESTING'] = True
    return app, app.test_client()


def upload(client, text):
    return client.post('/+upload', data={'text': text, 'filename': '中文.txt'},
                       headers={'Accept': 'application/json'}).json['name']


def test_utf8_head_links_and_escaping(site):
    app, client = site
    name = upload(client, '第一行\nhttps://example.com/?a=1&b=2\n<script>alert(1)</script>\n第四行')
    html = client.get('/+list?fragment=1').get_data(as_text=True)
    assert '第一行' in html and '第四行' not in html
    assert 'href="https://example.com/?a=1&amp;b=2"' in html
    assert '&lt;script&gt;' in html and '<script>alert(1)</script>' not in html
    detail = client.get('/' + name).get_data(as_text=True)
    assert '第四行' in detail and 'href="https://example.com/?a=1&amp;b=2"' in detail
    app.config['PASSWORDLESS'] = False
    app.config['DEFAULT_PERMISSIONS'] = 'list'
    assert '第一行' not in client.get('/+list?fragment=1').get_data(as_text=True)


def test_expiry_keep_change_forever_and_invalid(site):
    app, client = site
    name = upload(client, '原文')
    url = '/' + name + '/+modify'
    headers = {'Accept': 'application/json'}
    with app.storage.open(name) as item:
        original = item.meta['timestamp-max-life']
    result = client.post(url, data={'filename': '改名.txt', 'maxlife-preset': 'keep'}, headers=headers)
    assert result.json['expiry'] == original
    before = int(time.time())
    result = client.post(url, data={'maxlife-preset': 'HOURS:1'}, headers=headers)
    assert before + 3600 <= result.json['expiry'] <= int(time.time()) + 3600
    result = client.post(url, data={'filename': '不能保存.txt', 'maxlife-preset': 'DAYS:-1'}, headers=headers)
    assert result.status_code == 400
    with app.storage.open(name) as item:
        assert item.meta['filename'] == '改名.txt'
        assert item.data.read(item.data.size, 0) == '原文'.encode()
    result = client.post(url, data={'maxlife-preset': 'FOREVER:1'}, headers=headers)
    assert result.json['expiry'] < 0
    assert '永久保留' in result.json['expiry_label']
