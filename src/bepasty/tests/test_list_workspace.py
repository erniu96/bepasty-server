"""Direct list entry keeps list-only and non-JavaScript access usable."""
import pytest
from ..app import create_app
from ..config import Config


@pytest.mark.parametrize('permissions,workspace', [('list', False), ('list,create', True)])
def test_direct_list_permission_fallback(tmp_path, monkeypatch, permissions, workspace):
    monkeypatch.setattr(Config, 'STORAGE_FILESYSTEM_DIRECTORY', str(tmp_path))
    monkeypatch.setattr(Config, 'DEFAULT_PERMISSIONS', permissions)
    monkeypatch.setattr(Config, 'PASSWORDLESS', False)
    app = create_app()
    with app.test_client() as client:
        response = client.get('/+list')
        assert response.status_code == 200
        html = response.get_data(as_text=True)
        assert '<title>文件列表 · Bepasty</title>' in html
        assert 'id="native-library"' in html
        assert ('id="workspace"' in html) is workspace
        assert ('library-entry' in html) is workspace
        fragment = client.get('/+list?fragment=1')
        assert fragment.status_code == 200
        assert '<html' not in fragment.get_data(as_text=True)
        assert fragment.headers['Cache-Control'] == 'no-store'
