import errno
import time

from flask import current_app, request, render_template, jsonify
from flask.views import MethodView
from werkzeug.exceptions import Forbidden, NotFound

from ..constants import COMPLETE, FILENAME, LOCKED, TYPE, FOREVER, TIMESTAMP_MAX_LIFE
from ..utils.date_funcs import delete_if_lifetime_over, get_maxlife
from ..utils.http import redirect_next_referrer
from ..utils.permissions import ADMIN, MODIFY, may
from ..utils.upload import Upload
from ..utils.upload_lock import upload_lock


class ModifyView(MethodView):
    """Modify an item's filename or content type via a POST form submission."""
    def error(self, item, error):
        return render_template('error.html', heading=item.meta[FILENAME], body=error), 409

    def response(self, name, item):
        if request.accept_mimetypes.best == 'application/json':
            return jsonify(name=name, filename=item.meta[FILENAME],
                           contenttype=item.meta[TYPE],
                           expiry=item.meta[TIMESTAMP_MAX_LIFE],
                           expiry_label=(time.strftime("%Y-%m-%d %H:%M:%S",
                                                       time.gmtime(item.meta[TIMESTAMP_MAX_LIFE])) + " UTC"
                                         if item.meta[TIMESTAMP_MAX_LIFE] > 0 else "永久保留"))
        return redirect_next_referrer('bepasty.display', name=name)

    def get_params(self):
        return {
            FILENAME: request.form.get('filename'),
            TYPE: request.form.get('contenttype'),
        }

    def post(self, name):
        if not may(MODIFY):
            raise Forbidden()

        try:
            with upload_lock(current_app.storage, name), current_app.storage.openwrite(name) as item:
                if not item.meta[COMPLETE] and not may(ADMIN):
                    error = 'Upload incomplete. Try again later.'
                    return self.error(item, error)

                if item.meta[LOCKED] and not may(ADMIN):
                    raise Forbidden()

                if delete_if_lifetime_over(item, name):
                    raise NotFound()

                params = self.get_params()
                lifetime = None
                if request.form.get('maxlife-preset', 'keep') != 'keep':
                    lifetime = get_maxlife(request.form, underscore=False)
                if lifetime is not None:
                    item.meta[TIMESTAMP_MAX_LIFE] = (FOREVER if lifetime == FOREVER
                                                     else int(time.time()) + lifetime)
                if params[FILENAME]:
                    item.meta[FILENAME] = Upload.filter_filename(
                        params[FILENAME], name, params[TYPE], item.meta[TYPE]
                    )
                if params[TYPE]:
                    item.meta[TYPE], _ = Upload.filter_type(
                        params[TYPE], item.meta[TYPE]
                    )

                return self.response(name, item)

        except OSError as e:
            if e.errno == errno.ENOENT:
                raise NotFound()
            raise
