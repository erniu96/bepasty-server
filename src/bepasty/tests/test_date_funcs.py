import pytest
from werkzeug.exceptions import BadRequest

from bepasty.constants import FOREVER
from bepasty.utils.date_funcs import get_maxlife, time_unit_to_sec


def test_get_maxlife(testclient):
    with testclient:
        testclient.get("/")  # needed for config access via current_app
        assert get_maxlife({}, underscore=False) == 60 * 60 * 24 * 30
        assert get_maxlife({}, underscore=True) == 60 * 60 * 24 * 30


@pytest.mark.parametrize('underscore', [False, True])
@pytest.mark.parametrize('preset,seconds', [('hours:2', 7200), ('forever:1', FOREVER)])
def test_retention_preset(testclient, underscore, preset, seconds):
    with testclient:
        testclient.get('/')
        key = 'maxlife_preset' if underscore else 'maxlife-preset'
        assert get_maxlife({key: preset}, underscore) == seconds


@pytest.mark.parametrize('preset', ['days:0', 'days:-1', 'days:abc', 'bad:1', 'days', None])
def test_invalid_retention_preset(testclient, preset):
    with testclient:
        testclient.get('/')
        with pytest.raises(BadRequest):
            get_maxlife({'maxlife-preset': preset}, False)


@pytest.mark.parametrize('unit,expectation', [
    ('MINUTES', 60),
    ('HOURS', 60 * 60),
    ('DAYS', 60 * 60 * 24),
    ('WEEKS', 60 * 60 * 24 * 7),
    ('MONTHS', 60 * 60 * 24 * 30),
    ('YEARS', 60 * 60 * 24 * 365),
    ('FOREVER', FOREVER),
])
def test_unit_to_secs(unit, expectation):
    assert time_unit_to_sec(1, unit) == expectation
