"""Serialize browser upload commits across threads and local WSGI workers.

Keep a bounded set of lock files: removing a lock file can create two different
inodes and let concurrent workers enter the same critical section. These files
are deliberately retained, including after an upload is cancelled.
"""

from contextlib import contextmanager
from hashlib import sha256
import os
import threading

if os.name == 'nt':
    import msvcrt
else:
    import fcntl


_thread_locks = [threading.Lock() for _ in range(256)]


@contextmanager
def upload_lock(storage, name):
    """Lock a filesystem upload before opening its data and metadata.

    The 256 stripes allow unrelated uploads to proceed concurrently without
    creating a permanent file or Python lock for every upload. All workers must
    share the storage directory on a filesystem that supports advisory locks.
    """
    stripe = sha256(name.encode('utf-8')).digest()[0]
    lock_dir = os.path.join(storage.directory, '.upload-locks')
    with _thread_locks[stripe]:
        os.makedirs(lock_dir, mode=0o700, exist_ok=True)
        path = os.path.join(lock_dir, '{:02x}'.format(stripe))
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if os.name == 'nt':
                # locking operates from the current file position. It also
                # supports regions beyond EOF, so no initialization write races.
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == 'nt':
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
