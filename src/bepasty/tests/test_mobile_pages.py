"""Mobile page actions remain ordinary HTML links and forms without JavaScript."""

from html.parser import HTMLParser
from io import BytesIO
from urllib.parse import urlsplit

import pytest

from ..app import create_app
from ..config import Config


class PageControls(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.forms = {}
        self.form = None
        self.tags = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append((tag, attrs))
        if tag == 'form':
            assert self.form is None, 'Forms must not be nested.'
            self.form = {'attrs': attrs, 'controls': []}
            self.forms[attrs.get('id', attrs.get('action'))] = self.form
        elif self.form and tag in ('input', 'button', 'textarea', 'select'):
            self.form['controls'].append((tag, attrs))

    def handle_endtag(self, tag):
        if tag == 'form':
            self.form = None


@pytest.fixture
def page_client(tmp_path, monkeypatch):
    monkeypatch.delenv('BEPASTY_CONFIG', raising=False)
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', 'create,read,list,modify,delete,admin')
    monkeypatch.setattr(Config, 'APP_BASE_PATH', None)
    app = create_app()
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client


def upload(client, filename='中文笔记.txt', content_type='text/plain', data=b'contents'):
    response = client.post('/+upload', data={
        'file': (BytesIO(data), filename, content_type),
        'maxlife-unit': 'forever', 'maxlife-value': '1',
    })
    assert response.status_code == 302
    return urlsplit(response.headers['Location']).path


def collection(client, paths):
    response = client.post('/+upload', data={
        'text': '\n'.join(path.lstrip('/') for path in paths),
        'filename': '文件集合.txt', 'contenttype': 'text/x-bepasty-list',
    })
    assert response.status_code == 302
    return urlsplit(response.headers['Location']).path


def test_rename_entry_and_form_work_without_javascript(page_client):
    path = upload(page_client)
    response = page_client.get(path + '/+modify')
    assert response.status_code == 200
    page = PageControls(response.get_data(as_text=True))
    form = page.forms['modify-frm']
    assert form['attrs']['method'] == 'post'
    assert form['attrs']['action'] == path + '/+modify'
    assert any(tag == 'button' and attrs.get('type') == 'submit' for tag, attrs in form['controls'])
    assert any(attrs.get('name') == 'next' and attrs['value'] == path for _, attrs in form['controls'])

    response = page_client.post(form['attrs']['action'], data={
        'filename': '改名后的中文文件.txt', 'contenttype': 'text/plain', 'next': path,
    })
    assert response.status_code == 302
    assert response.headers['Location'] == path
    assert '改名后的中文文件.txt' in page_client.get(path).get_data(as_text=True)
    assert page_client.get(path + '/+download').data == b'contents'


def test_workspace_list_fragment_has_safe_names_and_preserves_upload_page(page_client):
    path = upload(page_client, '<script>bad & filename.txt')
    response = page_client.get('/+list?fragment=1')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    html = response.get_data(as_text=True)
    assert '<html' not in html
    assert '<script' not in html
    assert 'scriptbad  filename.txt' in html
    page = PageControls(html)
    filename_link = next(attrs for tag, attrs in page.tags if tag == 'a' and attrs.get('href') == path)
    assert filename_link['target'] == '_blank'
    assert filename_link['rel'] == 'noopener'
    share = next(attrs for tag, attrs in page.tags if tag == 'input' and attrs.get('aria-label') == '分享链接')
    assert share['value'] == path


def test_workspace_fragment_retains_list_permission_check(page_client):
    config = page_client.application.config
    config['PASSWORDLESS'] = False
    config['DEFAULT_PERMISSIONS'] = 'create,read'
    assert page_client.get('/+list?fragment=1').status_code == 403


def test_detail_has_native_edit_delete_and_readonly_share_link(page_client):
    path = upload(page_client)
    html = page_client.get(path).get_data(as_text=True)
    assert '<details' not in html
    page = PageControls(html)
    assert page.forms['modify-frm']['attrs']['method'] == 'post'
    delete = page.forms['del-frm']
    assert any(tag == 'button' and attrs.get('id') == 'del-btn' and attrs['type'] == 'submit'
               for tag, attrs in delete['controls'])
    share = next(attrs for tag, attrs in page.tags if tag == 'input' and attrs.get('aria-label') == '分享链接')
    assert 'readonly' in share
    assert urlsplit(share['value']).path == path
    response = page_client.post(delete['attrs']['action'], data={'next': '/+list'})
    assert response.status_code == 302
    assert response.headers['Location'] == '/+list'
    assert page_client.get(path).status_code == 404


def test_modify_requires_modify_permission_rather_than_create(page_client):
    path = upload(page_client)
    config = page_client.application.config
    config['PASSWORDLESS'] = False
    config['DEFAULT_PERMISSIONS'] = 'create,read'
    assert page_client.get(path + '/+modify').status_code == 403
    assert page_client.post(path + '/+modify', data={'filename': 'denied.txt'}).status_code == 403
    config['DEFAULT_PERMISSIONS'] = 'modify,read'
    assert page_client.get(path + '/+modify').status_code == 200
    assert page_client.post(path + '/+modify', data={'filename': 'renamed.txt'}).status_code == 302
    assert 'renamed.txt' in page_client.get(path).get_data(as_text=True)


def test_incomplete_uploads_never_offer_download_preview_or_share(page_client):
    response = page_client.post('/+upload/new', json={
        'filename': '还没上传完.png', 'size': 123, 'type': 'image/png',
    })
    assert response.status_code == 200
    path = '/' + response.json['name']
    for page_path in ('/+list', path):
        response = page_client.get(page_path)
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert '上传未完成' in html
        page = PageControls(html)
        assert not any(tag == 'a' and attrs.get('href', '').endswith(
            ('/+download', '/+inline', '/+qr', '/+carousel', '/+modify')) for tag, attrs in page.tags)
        assert not any(tag == 'input' and attrs.get('aria-label') == '分享链接' for tag, attrs in page.tags)
        assert not any(tag == 'img' for tag, _ in page.tags)
        assert any(tag == 'button' and attrs.get('type') == 'submit' for tag, attrs in page.tags)
    assert page_client.post(path + '/+delete', data={'next': '/+list'}).status_code == 302
    assert page_client.get(path).status_code == 404


def test_list_and_collection_use_cards_with_open_and_download_links(page_client):
    paths = [upload(page_client, '第一份.txt'), upload(page_client, '第二份.txt')]
    for response in (page_client.get('/+list'), page_client.get(collection(page_client, paths))):
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        page = PageControls(html)
        assert sum(tag == 'article' and attrs.get('role') == 'listitem' for tag, attrs in page.tags) == 2
        assert '<table' not in html
        assert '<details' not in html
        for item_path in paths:
            assert any(tag == 'a' and attrs.get('href') == item_path for tag, attrs in page.tags)
            assert any(tag == 'a' and attrs.get('href') == item_path + '/+download' for tag, attrs in page.tags)
            assert any(tag == 'input' and 'readonly' in attrs and
                       urlsplit(attrs.get('value', '')).path == item_path for tag, attrs in page.tags)


def test_gallery_uses_native_navigation_and_never_crops_images(page_client):
    paths = [upload(page_client, '第一张.png', 'image/png'), upload(page_client, '第二张.png', 'image/png')]
    response = page_client.get(collection(page_client, paths) + '/+carousel')
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    page = PageControls(html)
    assert any(tag == 'a' and attrs.get('href') == '#image-2' for tag, attrs in page.tags)
    assert any(tag == 'a' and attrs.get('href') == '#image-1' for tag, attrs in page.tags)
    assert sum(tag == 'img' and attrs.get('loading') == 'lazy' for tag, attrs in page.tags) == 2
    assert 'background-image' not in html


def test_gallery_omits_incomplete_images_in_a_complete_collection(page_client):
    path = upload(page_client, '完成.png', 'image/png')
    response = page_client.post('/+upload/new', json={
        'filename': '未完成.png', 'size': 123, 'type': 'image/png',
    })
    incomplete_path = '/' + response.json['name']
    response = page_client.get(collection(page_client, [path, incomplete_path]) + '/+carousel')
    assert response.status_code == 200
    page = PageControls(response.get_data(as_text=True))
    images = [attrs for tag, attrs in page.tags if tag == 'img']
    assert len(images) == 1
    assert images[0]['src'] == path + '/+inline'


def test_video_qr_and_error_pages_have_mobile_recovery_controls(page_client):
    path = upload(page_client, '视频.mp4', 'video/mp4')
    page = PageControls(page_client.get(path).get_data(as_text=True))
    video = next(attrs for tag, attrs in page.tags if tag == 'video')
    assert 'playsinline' in video
    assert video['preload'] == 'metadata'
    qr = page_client.get(path + '/+qr')
    assert qr.status_code == 200
    assert '<noscript>' in qr.get_data(as_text=True)
    qr_page = PageControls(qr.get_data(as_text=True))
    assert any(tag == 'a' and urlsplit(attrs.get('href', '')).path == path for tag, attrs in qr_page.tags)
    error = page_client.get('/abcdefgh')
    assert error.status_code == 404
    assert '到期' in error.get_data(as_text=True)
    error_page = PageControls(error.get_data(as_text=True))
    assert any(tag == 'a' and attrs.get('href') == '/+list' for tag, attrs in error_page.tags)
    assert any(tag == 'a' and attrs.get('href') == '/' for tag, attrs in error_page.tags)
