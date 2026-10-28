"""List expiry controls reuse partial modification and permission checks."""
import time
from html.parser import HTMLParser

import pytest

from .test_mobile_pages import page_client, upload, PageControls  # noqa: F401
from ..constants import TIMESTAMP_MAX_LIFE


@pytest.mark.parametrize('url', ['/+list', '/+list?fragment=1'])
def test_list_expiry_form(page_client, url):
    path = upload(page_client)
    page = PageControls(page_client.get(url).get_data(as_text=True))
    form = page.forms[path + '/+modify']
    assert form['attrs']['class'] == 'list-expiry-form'
    assert any(attrs.get('name') == 'maxlife-preset' for _, attrs in form['controls'])
    response = page_client.post(form['attrs']['action'], data={
        'maxlife-preset': 'DAYS:1', 'next': '/+list',
    })
    assert response.status_code == 302
    assert response.headers['Location'] == '/+list'
    assert page_client.get(path + '/+download').data == b'contents'


@pytest.mark.parametrize('preset,seconds', [('HOURS:1', 3600), ('DAYS:1', 86400),
                                          ('FOREVER:1', -1)])
def test_expiry_only_json_update(page_client, preset, seconds):
    path = upload(page_client)
    start = int(time.time())
    response = page_client.post(path + '/+modify', data={'maxlife-preset': preset},
                                headers={'Accept': 'application/json'})
    assert response.status_code == 200
    assert response.json['filename'] == '中文笔记.txt'
    assert response.json['contenttype'] == 'text/plain'
    expiry = response.json['expiry']
    if seconds < 0:
        assert expiry < 0
        assert response.json['expiry_label'] == '永久保留'
    else:
        assert start + seconds <= expiry <= int(time.time()) + seconds
    with page_client.application.storage.open(path[1:]) as item:
        assert item.meta[TIMESTAMP_MAX_LIFE] == expiry


class ToolbarControls(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.depth = 0
        self.controls = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'div':
            if self.depth or attrs.get('class') == 'file-row-actions':
                self.depth += 1
        if self.depth and tag in ('select', 'a', 'button'):
            self.controls.append(attrs)

    def handle_endtag(self, tag):
        if tag == 'div' and self.depth:
            self.depth -= 1


def test_all_list_actions_share_one_toolbar(page_client):
    upload(page_client)
    html = page_client.get('/+list?fragment=1').get_data(as_text=True)
    controls = ToolbarControls(html).controls
    assert any(c.get('name') == 'maxlife-preset' for c in controls)
    labels = {c.get('aria-label') for c in controls}
    assert {'下载', '复制内容', '复制链接', '重命名', '删除'} <= labels
    assert 'compact-share' in html


def test_list_without_modify_permission_has_no_editor(page_client):
    path = upload(page_client)
    page_client.application.config.update(PASSWORDLESS=False, DEFAULT_PERMISSIONS='list,read')
    html = page_client.get('/+list?fragment=1').get_data(as_text=True)
    assert 'list-expiry-form' not in html
    assert page_client.post(path + '/+modify', data={'maxlife-preset': 'DAYS:1'}).status_code == 403
