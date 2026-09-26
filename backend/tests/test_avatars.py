"""Technician avatar (profile photo) tests.

The avatar column is nullable on purpose: no photo means the UI falls back to
a monogram. These cover the storage contract, the access rules, and the
storage-failure path that must not leave an orphan file behind.
"""

import io
import os
import stat

from extensions import db
from models import User
from tests.base import BaseTestCase

PNG_1PX = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
    b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89'
)
JPEG_BYTES = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01' + b'\x00' * 32
HTML_DISGUISED_AS_PNG = b'<html><script>alert(1)</script></html>'


def _user(username):
    return User.query.filter_by(username=username).first()


class AvatarUploadTestCase(BaseTestCase):
    def tearDown(self):
        # The suite points UPLOAD_FOLDER at a shared temp path; keep it clean
        # so one test's file cannot satisfy another's assertion.
        import shutil
        shutil.rmtree(os.path.join(self.app.config['UPLOAD_FOLDER'], 'avatars'),
                      ignore_errors=True)
        super().tearDown()

    def test_user_without_photo_reports_null_avatar_url(self):
        r = self.client.get('/api/users', headers=self.admin_headers())
        body = {u['username']: u for u in r.get_json()}
        self.assertIsNone(body['staff']['avatar_url'])

    def test_admin_uploads_photo_for_staff(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        self.assertTrue(r.get_json()['avatar_url'])
        self.assertTrue(_user('staff').avatar_filename)

    def test_staff_uploads_own_photo(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.staff_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])

    def test_staff_cannot_upload_for_someone_else(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('admin').id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.staff_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 403)

    def test_requires_auth(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 401)

    def test_rejects_non_image_extension(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(b'hello'), 'payload.exe')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 400)
        self.assertIsNone(_user('staff').avatar_filename)

    def test_rejects_html_disguised_as_image(self):
        # A .png extension alone must not be enough: the bytes have to look
        # like an image, or the endpoint would serve attacker-controlled
        # markup from our own origin.
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(HTML_DISGUISED_AS_PNG), 'evil.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 400)
        self.assertIsNone(_user('staff').avatar_filename)

    def test_accepts_jpeg(self):
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(JPEG_BYTES), 'face.jpg')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])

    def test_accepts_a_blob_with_no_filename(self):
        # FormData.append('file', blob) with no filename is sent as "blob",
        # which has no extension. The stored format comes from the sniffed
        # bytes, so this must work rather than 400 on the extension check.
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'blob')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        # The extension must describe the real bytes, not the supplied name.
        self.assertTrue(_user('staff').avatar_filename.endswith('.png'),
                        _user('staff').avatar_filename)

    def test_stored_extension_follows_content_not_filename(self):
        # A JPEG named .png must be stored as a .jpg, so the Content-Type we
        # later serve matches the actual bytes.
        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(JPEG_BYTES), 'mislabelled.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        self.assertTrue(_user('staff').avatar_filename.endswith('.jpg'),
                        _user('staff').avatar_filename)

    def test_replacing_a_photo_deletes_the_old_file(self):
        first = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'a.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        old = _user('staff').avatar_filename
        old_path = os.path.join(
            self.app.config['UPLOAD_FOLDER'], 'avatars', old)
        self.assertTrue(os.path.exists(old_path))

        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(JPEG_BYTES), 'b.jpg')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        self.assertNotEqual(_user('staff').avatar_filename, old)
        self.assertFalse(os.path.exists(old_path),
                         'the superseded photo file was left on disk')

    def test_unwritable_storage_returns_507_and_stores_nothing(self):
        d = os.path.join(self.app.config['UPLOAD_FOLDER'], 'ro-avatars')
        os.makedirs(d, exist_ok=True)
        original = self.app.config['UPLOAD_FOLDER']
        self.app.config['UPLOAD_FOLDER'] = d
        os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(os.chmod, d, stat.S_IRWXU)
        self.addCleanup(lambda: self.app.config.__setitem__('UPLOAD_FOLDER', original))

        r = self.client.post(
            '/api/users/%d/avatar' % _user('staff').id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')

        self.assertEqual(r.status_code, 507, r.get_data(as_text=True)[:300])
        # The reference must not survive a file that never reached disk, or
        # every later render would point at a missing image.
        self.assertIsNone(_user('staff').avatar_filename)


class AvatarServeTestCase(BaseTestCase):
    def _upload(self, username='staff'):
        return self.client.post(
            '/api/users/%d/avatar' % _user(username).id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')

    def test_serves_photo_to_an_authenticated_caller(self):
        self._upload()
        r = self.client.get(
            '/api/users/%d/avatar' % _user('staff').id,
            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, PNG_1PX)

    def test_serves_via_query_token_for_img_tags(self):
        # An <img> cannot send an Authorization header, which is the same
        # constraint the SSE stream documents.
        self._upload()
        token = self.login().get_json()['access_token']
        r = self.client.get(
            '/api/users/%d/avatar?token=%s' % (_user('staff').id, token))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, PNG_1PX)

    def test_unsigned_request_is_refused(self):
        # Ids are sequential, so without this every staff photo would be
        # readable by anyone who guessed a number.
        self._upload()
        r = self.client.get('/api/users/%d/avatar' % _user('staff').id)
        self.assertEqual(r.status_code, 401)

    def test_invalid_query_token_is_refused(self):
        self._upload()
        r = self.client.get(
            '/api/users/%d/avatar?token=not-a-real-token' % _user('staff').id)
        self.assertEqual(r.status_code, 401)

    def test_missing_photo_is_404(self):
        r = self.client.get(
            '/api/users/%d/avatar' % _user('staff').id,
            headers=self.admin_headers())
        self.assertEqual(r.status_code, 404)


class AvatarDeleteTestCase(BaseTestCase):
    def _upload(self, username='staff'):
        return self.client.post(
            '/api/users/%d/avatar' % _user(username).id,
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')

    def test_delete_clears_reference_and_file(self):
        self._upload()
        stored = _user('staff').avatar_filename
        path = os.path.join(self.app.config['UPLOAD_FOLDER'], 'avatars', stored)
        self.assertTrue(os.path.exists(path))

        r = self.client.delete(
            '/api/users/%d/avatar' % _user('staff').id,
            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        self.assertIsNone(_user('staff').avatar_filename)
        self.assertIsNone(r.get_json()['avatar_url'])
        self.assertFalse(os.path.exists(path))

    def test_staff_cannot_delete_someone_elses_photo(self):
        self._upload('staff')
        r = self.client.delete(
            '/api/users/%d/avatar' % _user('staff').id,
            headers=self.staff_headers())
        # Allowed: this is their own photo.
        self.assertEqual(r.status_code, 200)
        self._upload('admin')
        r = self.client.delete(
            '/api/users/%d/avatar' % _user('admin').id,
            headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_delete_requires_auth(self):
        r = self.client.delete('/api/users/%d/avatar' % _user('staff').id)
        self.assertEqual(r.status_code, 401)


class AvatarEmojiTestCase(BaseTestCase):
    """Emoji avatars: the fallback for a user with no photo to upload.

    The stored value is rendered into the DOM, so validation is a security
    boundary rather than tidiness. It is a whitelist, so anything that is not
    an emoji is refused outright.
    """

    def _put(self, user_id, payload):
        return self.client.put(
            f'/api/users/{user_id}/avatar/emoji',
            json=payload,
            headers=self.admin_headers())

    def _me(self, username):
        r = self.client.get('/api/users', headers=self.admin_headers())
        return {u['username']: u for u in r.get_json()}[username]

    def test_set_and_read_back(self):
        uid = _user('staff').id
        r = self._put(uid, {'emoji': '\U0001F98A'})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        self.assertEqual(r.get_json()['avatar_emoji'], '\U0001F98A')
        # Survives a re-read, so it is persisted and not just echoed back.
        self.assertEqual(self._me('staff')['avatar_emoji'], '\U0001F98A')

    def test_multi_codepoint_sequence_is_allowed(self):
        # A flag is two regional indicators and a keycap needs its enclosing
        # mark, so a naive one-character check would refuse legitimate picks.
        for emoji in ('\U0001F1EA\U0001F1EC', '1\uFE0F\u20E3',
                      '\U0001F469\u200D\U0001F4BB'):
            with self.subTest(emoji=emoji):
                r = self._put(_user('staff').id, {'emoji': emoji})
                self.assertEqual(r.status_code, 200, emoji)
                self.assertEqual(r.get_json()['avatar_emoji'], emoji)

    def test_rejects_plain_text_and_markup(self):
        for bad in ('hello', 'a', ' ', '<script>alert(1)</script>',
                    '<img src=x onerror=alert(1)>', '"/><b>x', 'ok\u0000'):
            with self.subTest(value=bad):
                r = self._put(_user('staff').id, {'emoji': bad})
                self.assertEqual(r.status_code, 400, bad)
        # Nothing was written by any of the refusals.
        self.assertIsNone(_user('staff').avatar_emoji)

    def test_rejects_right_to_left_override(self):
        # U+202E is outside every allowed range, so it cannot be used to make a
        # technician's name render backwards.
        r = self._put(_user('staff').id, {'emoji': '\u202Eabc'})
        self.assertEqual(r.status_code, 400)

    def test_rejects_overlong_value(self):
        r = self._put(_user('staff').id, {'emoji': '\U0001F600' * 9})
        self.assertEqual(r.status_code, 400)

    def test_emoji_and_photo_are_mutually_exclusive(self):
        """The disc shows one thing, so the two representations must not
        coexist or a reader would have no way to tell which is current."""
        uid = _user('staff').id
        self._put(uid, {'emoji': '\U0001F600'})
        r = self.client.post(
            f'/api/users/{uid}/avatar',
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200)
        user = _user('staff')
        self.assertIsNotNone(user.avatar_filename)
        self.assertIsNone(user.avatar_emoji)

    def test_setting_emoji_removes_the_photo_and_its_file(self):
        import shutil
        uid = _user('staff').id
        self.client.post(
            f'/api/users/{uid}/avatar',
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        stored = _user('staff').avatar_filename
        self.assertIsNotNone(stored)
        path = os.path.join(self.app.config['UPLOAD_FOLDER'], 'avatars', stored)
        self.assertTrue(os.path.exists(path))

        self._put(uid, {'emoji': '\U0001F433'})
        user = _user('staff')
        self.assertEqual(user.avatar_emoji, '\U0001F433')
        self.assertIsNone(user.avatar_filename)
        # The file is gone too, not just dereferenced.
        self.assertFalse(os.path.exists(path))
        shutil.rmtree(os.path.join(self.app.config['UPLOAD_FOLDER'], 'avatars'),
                      ignore_errors=True)

    def test_clear_returns_to_monogram(self):
        uid = _user('staff').id
        self._put(uid, {'emoji': '\U0001F600'})
        r = self.client.delete(f'/api/users/{uid}/avatar/emoji',
                               headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(r.get_json()['avatar_emoji'])
        self.assertIsNone(_user('staff').avatar_emoji)

    def test_clear_when_none_set_is_harmless(self):
        r = self.client.delete(f"/api/users/{_user('staff').id}/avatar/emoji",
                               headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)

    def test_no_photo_and_no_emoji_reports_both_null(self):
        body = self._me('staff')
        self.assertIsNone(body['avatar_url'])
        self.assertIsNone(body['avatar_emoji'])

    def test_requires_auth(self):
        r = self.client.put(f"/api/users/{_user('staff').id}/avatar/emoji",
                            json={'emoji': '\U0001F600'})
        self.assertEqual(r.status_code, 401)

    def test_staff_can_set_their_own_but_not_someone_elses(self):
        # The fixtures are admin and staff, so admin is the "someone else".
        # The cross-user attempt must authenticate as staff, or it would just
        # be an admin editing themselves and prove nothing.
        r = self.client.put(f"/api/users/{_user('staff').id}/avatar/emoji",
                            json={'emoji': '\U0001F600'},
                            headers=self.staff_headers())
        self.assertEqual(r.status_code, 200)
        r2 = self.client.put(f"/api/users/{_user('admin').id}/avatar/emoji",
                             json={'emoji': '\U0001F600'},
                             headers=self.staff_headers())
        self.assertEqual(r2.status_code, 403)
        self.assertIsNone(_user('admin').avatar_emoji)

    def test_staff_cannot_clear_someone_elses_emoji(self):
        self._put(_user('staff').id, {'emoji': '\U0001F600'})
        r = self.client.delete(f"/api/users/{_user('staff').id}/avatar/emoji",
                               headers=self.staff_headers())
        self.assertEqual(r.status_code, 200)
        r2 = self.client.delete(f"/api/users/{_user('admin').id}/avatar/emoji",
                                headers=self.staff_headers())
        self.assertEqual(r2.status_code, 403)

    def test_unknown_user_is_404(self):
        r = self._put(999999, {'emoji': '\U0001F600'})
        self.assertEqual(r.status_code, 404)

    def test_raw_filename_is_never_exposed(self):
        r = self.client.post(
            f"/api/users/{_user('staff').id}/avatar",
            data={'file': (io.BytesIO(PNG_1PX), 'face.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertNotIn('avatar_filename', r.get_json())


class MyProfileAvatarTestCase(BaseTestCase):
    """The "My Profile" dialog reads /api/users/me, not /api/users.

    The admin profile card and the sidebar identity block render the signed-in
    admin's avatar from that response, so if it ever stopped carrying the avatar
    fields the card would silently fall back to a monogram while the Users table
    still showed the photo. These lock the contract both surfaces depend on.
    """

    def tearDown(self):
        import shutil
        shutil.rmtree(os.path.join(self.app.config['UPLOAD_FOLDER'], 'avatars'),
                      ignore_errors=True)
        super().tearDown()

    def test_me_reports_no_avatar_fields_set(self):
        r = self.client.get('/api/users/me', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        body = r.get_json()
        self.assertIsNone(body['avatar_url'])
        self.assertIsNone(body['avatar_emoji'])

    def test_me_reports_emoji_after_it_is_set_for_self(self):
        uid = _user('admin').id
        r = self.client.put(f'/api/users/{uid}/avatar/emoji',
                            json={'emoji': '\U0001F680'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        # Read it back through the endpoint the profile dialog actually uses.
        me = self.client.get('/api/users/me', headers=self.admin_headers()).get_json()
        self.assertEqual(me['avatar_emoji'], '\U0001F680')
        self.assertIsNone(me['avatar_url'])

    def test_me_reports_photo_url_after_self_upload(self):
        uid = _user('admin').id
        r = self.client.post(
            f'/api/users/{uid}/avatar',
            data={'file': (io.BytesIO(PNG_1PX), 'me.png')},
            headers=self.admin_headers(),
            content_type='multipart/form-data')
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        me = self.client.get('/api/users/me', headers=self.admin_headers()).get_json()
        self.assertEqual(me['avatar_url'], f'/api/users/{uid}/avatar')
        # The endpoint is not a public URL: it needs a token, which the client
        # appends as a query parameter for <img> tags.
        self.assertIsNone(me['avatar_emoji'])

    def test_me_and_users_list_agree_on_the_avatar(self):
        # The two surfaces the admin sees must never disagree about their face.
        uid = _user('admin').id
        self.client.put(f'/api/users/{uid}/avatar/emoji',
                        json={'emoji': '\U0001F9D1'},
                        headers=self.admin_headers())
        me = self.client.get('/api/users/me', headers=self.admin_headers()).get_json()
        listed = {u['username']: u for u in self.client.get(
            '/api/users', headers=self.admin_headers()).get_json()}['admin']
        self.assertEqual(me['avatar_emoji'], listed['avatar_emoji'])
        self.assertEqual(me['avatar_url'], listed['avatar_url'])

    def test_me_requires_auth(self):
        self.assertEqual(self.client.get('/api/users/me').status_code, 401)
