"""Upload locks must coordinate independent server processes and recover exits."""

import multiprocessing
from types import SimpleNamespace

import pytest

from ..utils.upload_lock import upload_lock


def enter_lock(directory, channel):
    channel.send('waiting')
    with upload_lock(SimpleNamespace(directory=directory), 'same-upload'):
        channel.send('entered')
    channel.close()


def hold_lock(directory, channel):
    with upload_lock(SimpleNamespace(directory=directory), 'same-upload'):
        channel.send('entered')
        channel.recv()


def test_workers_wait_for_committing_worker(tmp_path):
    ctx = multiprocessing.get_context('spawn')
    parent, child = ctx.Pipe()
    process = ctx.Process(target=enter_lock, args=(str(tmp_path), child))
    try:
        with upload_lock(SimpleNamespace(directory=str(tmp_path)), 'same-upload'):
            process.start()
            assert parent.poll(10)
            assert parent.recv() == 'waiting'
            assert not parent.poll(0.2)
        assert parent.poll(10)
        assert parent.recv() == 'entered'
        process.join(10)
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
            process.join(10)
        parent.close()
        child.close()


def test_worker_exit_releases_lock(tmp_path):
    ctx = multiprocessing.get_context('spawn')
    parent, child = ctx.Pipe()
    process = ctx.Process(target=hold_lock, args=(str(tmp_path), child))
    process.start()
    try:
        assert parent.poll(10)
        assert parent.recv() == 'entered'
        process.terminate()
        process.join(10)
        # A killed worker must not leave a stale directory/exclusive-create lock.
        with upload_lock(SimpleNamespace(directory=str(tmp_path)), 'same-upload'):
            pass
    finally:
        if process.is_alive():
            process.terminate()
            process.join(10)
        parent.close()
        child.close()


def test_exception_releases_lock(tmp_path):
    storage = SimpleNamespace(directory=str(tmp_path))
    with pytest.raises(RuntimeError):
        with upload_lock(storage, 'same-upload'):
            raise RuntimeError('failed write')
    with upload_lock(storage, 'same-upload'):
        pass
    assert len(list((tmp_path / '.upload-locks').iterdir())) == 1
