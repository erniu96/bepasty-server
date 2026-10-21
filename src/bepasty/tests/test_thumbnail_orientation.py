"""Thumbnail pixels must honor EXIF, while downloads stay byte-for-byte intact."""
from io import BytesIO

import pytest

from .test_filenames import filename_client, upload_file

Image = pytest.importorskip('PIL.Image')

# Expected corner order (TL, TR, BL, BR), independently specified for EXIF 1-8.
CORNERS = {
    1: (0, 1, 2, 3), 2: (1, 0, 3, 2), 3: (3, 2, 1, 0),
    4: (2, 3, 0, 1), 5: (0, 2, 1, 3), 6: (2, 0, 3, 1),
    7: (3, 1, 2, 0), 8: (1, 3, 0, 2),
}
COLORS = ((240, 20, 20), (20, 240, 20), (20, 20, 240), (240, 240, 20))


@pytest.mark.parametrize('fmt,mime', [('JPEG', 'image/jpeg'), ('PNG', 'image/png'), ('WEBP', 'image/webp')])
@pytest.mark.parametrize('orientation', [None, *range(1, 9)])
def test_thumbnail_orientation(filename_client, fmt, mime, orientation):
    _, client = filename_client
    source = Image.new('RGB', (240, 160))
    for box, color in zip(((0, 0, 120, 80), (120, 0, 240, 80),
                           (0, 80, 120, 160), (120, 80, 240, 160)), COLORS):
        source.paste(color, box)
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    buf = BytesIO()
    source.save(buf, fmt, exif=exif)
    payload = buf.getvalue()
    path, _ = upload_file(client, '方向测试.' + fmt.lower(), payload, mime)
    response = client.get(path + '/+thumbnail')
    assert response.status_code == 200
    assert response.content_type == mime
    with Image.open(BytesIO(response.data)) as thumb:
        assert thumb.size == ((72, 108) if orientation in (5, 6, 7, 8) else (162, 108))
        assert thumb.getexif().get(274, 1) == 1
        rgb = thumb.convert('RGB')
        w, h = rgb.size
        actual = [rgb.getpixel(p) for p in ((w//4, h//4), (3*w//4, h//4),
                                           (w//4, 3*h//4), (3*w//4, 3*h//4))]
        for pixel, index in zip(actual, CORNERS[orientation or 1]):
            assert max(abs(a-b) for a, b in zip(pixel, COLORS[index])) < 20
    assert client.get(path + '/+download').data == payload
