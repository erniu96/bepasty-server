import os
import errno
from contextlib import contextmanager
from io import BytesIO
import time
import urllib

from flask import abort, current_app, jsonify, request, url_for
from flask.views import MethodView
from werkzeug.exceptions import NotFound, Forbidden

from ..constants import COMPLETE, FILENAME, SIZE, WEB_UPLOAD_OFFSET
from ..utils.date_funcs import get_maxlife
from ..utils.http import ContentRange, redirect_next
from ..utils.name import ItemName
from ..utils.permissions import CREATE, may
from ..utils.upload import Upload, create_item, background_compute_hash
from ..utils.upload_lock import upload_lock


@contextmanager
def open_upload_item(name, writable=False):
    # Read metadata only after acquiring the lock. An item opened beforehand
    # could contain a stale offset even if its later write is serialized.
    storage = current_app.storage
    with upload_lock(storage, name):
        try:
            item = storage.openwrite(name) if writable else storage.open(name)
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                raise NotFound()
            raise
        with item:
            yield item


class UploadView(MethodView):
    def post(self):
        if not may(CREATE):
            raise Forbidden()
        f = request.files.get('file')
        t = request.form.get('text')
        # Note: "and f.filename" is needed due to a missing __bool__ method in
        # werkzeug.datastructures.FileStorage, to work around it crashing
        # on Python 3.x.
        if f and f.filename:
            # Check Content-Range, disallow its usage
            if ContentRange.from_request():
                abort(416)

            # Check Content-Type; default to application/octet-stream
            content_type = (
                f.headers.get('Content-Type') or
                request.headers.get('Content-Type'))
            content_type_hint = 'application/octet-stream'
            filename = f.filename

            # Get size of temporary file
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(0)
        elif t is not None:
            # t is already Unicode, but we want UTF-8 for storage
            t = t.encode('utf-8')
            content_type = request.form.get('contenttype')  # TODO: add coding
            content_type_hint = 'text/plain'
            size = len(t)
            f = BytesIO(t)
            filename = request.form.get('filename')
        else:
            raise NotImplementedError
        # Set the maximum lifetime
        maxtime = get_maxlife(request.form, underscore=False)
        maxlife_timestamp = int(time.time()) + maxtime if maxtime > 0 else maxtime
        name = create_item(f, filename, size, content_type, content_type_hint, maxlife_stamp=maxlife_timestamp)
        # Progressive enhancement: native forms still redirect, while the same
        # form submitted by the workspace receives the stored, normalized name.
        if request.accept_mimetypes.best == 'application/json':
            with open_upload_item(name) as item:
                return jsonify(UploadContinueView.status(item, name)), 201
        kw = {}
        kw['_anchor'] = urllib.parse.quote(filename or '')
        if content_type == 'text/x-bepasty-redirect':
            # After creating a redirect, we want to stay on the Bepasty
            # redirect display so the user can copy the URL.
            kw['delay'] = '9999'
        return redirect_next('bepasty.display', name=name, **kw)


class UploadNewView(MethodView):
    def post(self):
        if not may(CREATE):
            raise Forbidden()

        data = request.get_json()

        data_filename = data['filename']
        data_size = Upload.filter_size(data.get('size'))
        data_type = data['type']

        # Set the maximum lifetime
        maxtime = get_maxlife(data, underscore=True)
        maxlife_timestamp = int(time.time()) + maxtime if maxtime > 0 else maxtime

        name = ItemName.create(current_app.storage)
        with current_app.storage.create(name, data_size) as item:
            # Save metadata
            Upload.meta_new(item, data_size, data_filename, data_type,
                            'application/octet-stream', name, maxlife_stamp=maxlife_timestamp)
            item.meta[WEB_UPLOAD_OFFSET] = 0

            return jsonify({'url': url_for('bepasty.upload_continue', name=name),
                            'name': name})


class UploadContinueView(MethodView):
    @staticmethod
    def committed_offset(item):
        size = item.meta[SIZE]
        if item.meta[COMPLETE]:
            if item.data.size != size:
                abort(409, description='Completed upload data does not match its declared size')
            return size
        # Historical partial files may contain holes or unconfirmed bytes. Their
        # length cannot establish a contiguous committed offset, so restart at 0.
        offset = item.meta.get(WEB_UPLOAD_OFFSET, 0)
        if not isinstance(offset, int) or not 0 <= offset <= size or offset > item.data.size:
            abort(409, description='Upload offset is inconsistent with stored data')
        if size and offset == size:
            abort(409, description='Upload has all bytes committed but is not complete')
        return offset

    @classmethod
    def status(cls, item, name, include_incomplete_files=False):
        complete = bool(item.meta[COMPLETE])
        files = []
        if complete or include_incomplete_files:
            files.append({
                'name': name,
                'filename': item.meta[FILENAME],
                'title_pending': bool(item.meta.get('auto-title-pending', False)),
                'status_url': url_for('bepasty.upload_continue', name=name),
                'size': item.meta[SIZE],
                'url': '{}#{}'.format(url_for('bepasty.display', name=name), item.meta[FILENAME]),
            })
        return {'name': name, 'size': item.meta[SIZE],
                'uploaded_bytes': cls.committed_offset(item), 'complete': complete, 'files': files}

    def get(self, name):
        if not may(CREATE):
            raise Forbidden()
        with open_upload_item(name) as item:
            result = jsonify(self.status(item, name))
        # Resume must observe the latest acknowledgement, including a lost final response.
        result.headers['Cache-Control'] = 'no-store'
        return result

    def post(self, name):
        if not may(CREATE):
            raise Forbidden()

        f = request.files['file']
        if not f:
            raise NotImplementedError

        # Check Content-Range
        content_range = ContentRange.from_request()

        # Validate the received file before writing or marking the item complete.
        # A browser can report a nonzero File.size yet send an empty/truncated file.
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(0)

        with open_upload_item(name, writable=True) as item:
            if item.meta[COMPLETE]:
                abort(409, description='Upload is already complete')
            offset = self.committed_offset(item)
            if content_range:
                if content_range.complete != item.meta[SIZE]:
                    abort(400, description='Content-Range total does not match the declared file size')
                if size != content_range.size:
                    abort(400, description='Uploaded chunk size does not match Content-Range')
                if content_range.begin != offset:
                    abort(409, description='Content-Range does not start at the committed upload offset')
                # Note: we ignore the hash as it is only for one chunk, not for the whole upload.
                # Also, we cannot continue computing the hash as we can't save the internal
                # state of the hash object.
                item.data._file.truncate(offset)
                size_written, _ = Upload.data(item, f, content_range.size, offset)
                file_hash = ''
                is_complete = content_range.is_complete

            else:
                if size != item.meta[SIZE]:
                    abort(400, description='Uploaded file size does not match the declared file size')
                if offset:
                    abort(409, description='Upload already has committed chunks; resume with Content-Range')

                item.data._file.truncate(0)
                size_written, file_hash = Upload.data(item, f, size)
                is_complete = True

            # Publish only bytes successfully written in this request. Flush once
            # per chunk before metadata is saved and before responding to the client.
            item.data._file.flush()
            item.meta[WEB_UPLOAD_OFFSET] = offset + size_written
            if is_complete:
                Upload.meta_complete(item, file_hash)

            result = jsonify(self.status(item, name, include_incomplete_files=True))

        if is_complete and not file_hash:
            background_compute_hash(current_app.storage, name)

        return result


class UploadAbortView(MethodView):
    def get(self, name):
        if not may(CREATE):
            raise Forbidden()

        # Do not delete data while a chunk is saving. Closing the read handle
        # before removing the files also keeps this path usable on Windows.
        with upload_lock(current_app.storage, name):
            try:
                with current_app.storage.open(name) as item:
                    if item.meta[COMPLETE]:
                        return 'Upload complete. Cannot delete file-upload garbage.', 409
                current_app.storage.remove(name)
            except OSError as e:
                if e.errno == errno.ENOENT:
                    raise NotFound()
                raise
        return 'Upload aborted'
