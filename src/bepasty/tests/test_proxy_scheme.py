import pytest
from flask import Flask, request, url_for

from bepasty.app import TrustedSchemeMiddleware


@pytest.mark.parametrize('source,proto,expected', [
    ('10.10.10.222', 'https', 'https'),
    ('10.10.10.222', 'http', 'http'),
    ('10.10.10.223', 'https', 'http'),
    ('10.10.10.222', 'https,http', 'http'),
    ('10.10.10.222', 'javascript', 'http'),
    ('10.10.10.222', None, 'http'),
])
def test_forwarded_scheme_from_exact_gateway_only(source, proto, expected):
    app = Flask(__name__)
    app.wsgi_app = TrustedSchemeMiddleware(app.wsgi_app, ['10.10.10.222'])

    @app.route('/')
    def index():
        return dict(url=url_for('index', _external=True), remote=request.remote_addr)

    headers = {'X-Forwarded-Host': 'other.example', 'X-Forwarded-For': '1.2.3.4'}
    if proto is not None:
        headers['X-Forwarded-Proto'] = proto
    result = app.test_client().get('/', base_url='http://paste.example', headers=headers,
                                   environ_overrides={'REMOTE_ADDR': source}).get_json()
    assert result == dict(url=expected + '://paste.example/', remote=source)
