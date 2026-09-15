import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import Flask
from flask_jwt_extended import create_access_token

from tests.base import make_test_app
from extensions import db
from models import SystemEvent
from routes.main import event_stream


class EventStreamContextTest(unittest.TestCase):
    """Regression: the /api/events/stream generator body is iterated by the
    WSGI layer AFTER the request/app context has been popped. It used to call
    current_app inside the generator and crash with
    RuntimeError: Working outside of application context."""

    @classmethod
    def setUpClass(cls):
        cls.app = make_test_app()

    def test_stream_generator_survives_popped_context(self):
        ctx = self.app.app_context()
        ctx.push()
        try:
            db.create_all()
            token = create_access_token(
                identity='2',
                additional_claims={'role': 'staff', 'username': 'staff'},
            )
            ev = SystemEvent(type='ticket.updated', payload='{"ok":true}')
            db.session.add(ev)
            db.session.commit()
            ev_id = ev.id

            with self.app.test_request_context(
                    f'/api/events/stream?token={token}&last_id=0'):
                resp = event_stream()
                generator = resp.response

            # The request context is now popped (the `with` block ended);
            # pop the app context too, mirroring the position werkzeug is in
            # when it lazily iterates the stream body.
        finally:
            ctx.pop()

        it = iter(generator)
        self.assertEqual(next(it), ': connected\n\n')
        second = next(it)
        self.assertIn(f'id: {ev_id}', second)

        generator.close()

    def test_stream_requires_token(self):
        client = self.app.test_client()
        r = client.get('/api/events/stream')
        self.assertEqual(r.status_code, 401)


if __name__ == '__main__':
    unittest.main()