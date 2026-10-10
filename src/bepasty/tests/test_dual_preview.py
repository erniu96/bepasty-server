import pytest
from ..app import create_app
from ..config import Config


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'PASSWORDLESS', True)
    app = create_app()
    app.config['TESTING'] = True
    return app.test_client()


def show(client, text, filename):
    name = client.post('/+upload', data={'text': text, 'filename': filename},
                       headers={'Accept': 'application/json'}).json['name']
    return client.get('/' + name).get_data(as_text=True)


def test_markdown_has_plain_and_rendered(client):
    html = show(client, '# 标题\n\n**粗** <script>alert(1)</script>', '笔记.md')
    assert 'class="dual-preview"' in html
    assert '<pre class="text-content dual-plain"># 标题' in html
    assert 'srcdoc="' in html and '&lt;h1&gt;标题&lt;/h1&gt;' in html
    assert 'sandbox="allow-popups allow-popups-to-escape-sandbox"' in html
    assert '<script>alert(1)</script>' not in html


def test_html_has_plain_and_rendered(client):
    html = show(client, '<h1>Hi</h1><script>alert(1)</script>', 'page.html')
    assert 'class="dual-preview"' in html
    assert '&lt;h1&gt;Hi&lt;/h1&gt;' in html
    assert '<script>alert(1)</script>' not in html


def test_txt_unchanged(client):
    html = show(client, '# 标题', 'a.txt')
    assert 'dual-preview' not in html and '<pre class="text-content"># 标题' in html


def test_markdown_detected_by_content(client):
    html = show(client, '# 标题\n\n- 一\n- 二\n', 'note.txt')
    assert 'class="dual-preview"' in html and 'prefers-color-scheme:dark' in html


def test_html_detected_by_content(client):
    html = show(client, '<!doctype html><p>Hi</p>', 'paste.txt')
    assert 'class="dual-preview"' in html
    assert '&lt;!doctype html&gt;&lt;style&gt;:root{color-scheme:light dark}' in html


def test_plain_text_with_md_suffix_not_rendered(client):
    html = show(client, '只是一行字', 'a.md')
    assert 'dual-preview' not in html


def test_code_type_not_sniffed(client):
    html = show(client, '# 注释\n- x\n**y**\n', 'a.py')
    assert 'dual-preview' not in html


def test_styled_html_left_alone(client):
    html = show(client, '<html><body style="background:#fff"><p>x</p></body></html>', 'a.html')
    assert 'class="dual-preview"' in html and 'color-scheme:light dark' not in html


def test_markdown_with_inline_html(client):
    html = show(client, '<p align="center"><img src="x.png"></p>\n\n# 名字\n\n- a\n- b\n', 'README')
    assert '&lt;h1&gt;名字&lt;/h1&gt;' in html
