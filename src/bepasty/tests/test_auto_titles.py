from io import BytesIO

import pytest
from bepasty.app import create_app
from bepasty.config import Config
from bepasty.utils import title


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read,modify')
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config.update(TESTING=True, AUTO_TITLES=True)
    jobs = []
    monkeypatch.setattr(title, 'schedule_title', lambda *args: jobs.append(args) or True)
    return app, app.test_client(), jobs


def post(client, **fields):
    return client.post('/+upload', data={'text': '家庭备份与异地恢复方案', **fields},
                       headers={'Accept': 'application/json'})


def test_unnamed_text_returns_before_title(setup):
    app, client, jobs = setup
    result = post(client).json
    file = result['files'][0]
    assert file['filename'] == '文字分享.txt'
    assert file['title_pending'] and result['complete']
    assert len(jobs) == 1
    assert client.get(file['status_url']).json['files'][0]['title_pending']


@pytest.mark.parametrize('fields', [{'filename': '手写.txt'}, {'contenttype': 'text/x-bepasty-list'}])
def test_explicit_title_and_collection_preserved(setup, fields):
    app, client, jobs = setup
    assert post(client, **fields).status_code == 201
    assert jobs == []


def test_original_file_name_preserved(setup):
    app, client, jobs = setup
    result = client.post('/+upload', data={'file': (BytesIO(b'hello'), 'original.txt')},
                         headers={'Accept': 'application/json'}).json
    assert result['files'][0]['filename'] == 'original.txt'
    assert not jobs


@pytest.mark.parametrize('rename,fail', [(False, False), (True, False), (False, True)])
def test_worker_success_manual_rename_and_failure(setup, monkeypatch, rename, fail):
    app, client, jobs = setup
    result = post(client).json
    name = result['name']
    if rename:
        with app.storage.openwrite(name) as item:
            item.meta['filename'] = '自己命名.txt'

    def generate(text, model):
        assert text == '家庭备份与异地恢复方案'
        if fail:
            raise TimeoutError()
        return '家庭备份方案.txt'
    monkeypatch.setattr(title, 'generate_title', generate)
    assert title._slots.acquire(blocking=False)
    title._worker(*jobs[0])
    file = client.get(result['files'][0]['status_url']).json['files'][0]
    assert not file['title_pending']
    assert file['filename'] == ('自己命名.txt' if rename else '文字分享.txt' if fail else '家庭备份方案.txt')
