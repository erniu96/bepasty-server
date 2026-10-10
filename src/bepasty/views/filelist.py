import errno
import pickle

from flask import current_app, render_template, request, make_response
from flask.views import MethodView
from werkzeug.exceptions import Forbidden

from ..constants import ID, TIMESTAMP_UPLOAD
from ..utils.date_funcs import delete_if_lifetime_over
from ..utils.permissions import ADMIN, LIST, READ, may
from ..utils.text_preview import is_txt, text_head


def file_infos(names=None, preview=False):
    """
    Iterate over storage files' metadata.

    Note: we put the storage name into the metadata as ID.

    :param names: None means "all items"; otherwise, provide a list of storage item names
    """
    storage = current_app.storage
    if names is None:
        names = list(storage)
    for name in names:
        try:
            with storage.open(name) as item:
                meta = dict(item.meta)
                if not meta:
                    # We got empty metadata; this happens for 0-byte .meta files.
                    # Ignore it for now.
                    continue
                if delete_if_lifetime_over(item, name):
                    continue
                if (preview and meta.get("complete") and is_txt(meta) and may(READ)
                        and (not meta.get("locked") or may(ADMIN))):
                    meta["text_head"] = text_head(item)
                meta[ID] = name
                yield meta
        except OSError as e:
            if e.errno != errno.ENOENT:
                raise
        except pickle.UnpicklingError:
            # Corrupted meta file; just ignore it for now.
            pass


class FileListView(MethodView):
    def get(self):
        if not may(LIST):
            raise Forbidden()
        files = sorted(file_infos(preview=True), key=lambda f: f[TIMESTAMP_UPLOAD], reverse=True)
        if request.args.get('fragment') == '1':
            response = make_response(render_template('_workspace_filelist.html', files=files))
            response.headers['Cache-Control'] = 'no-store'
            return response
        return render_template('filelist.html', files=files)
