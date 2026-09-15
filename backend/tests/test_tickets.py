"""Ticket lifecycle tests: create/list/update/comment + role-based access."""

from extensions import db
from models import Notification, Ticket
from tests.base import BaseTestCase


def _latest_ticket():
    return Ticket.query.order_by(Ticket.id.desc()).first()


class CreateTicketTestCase(BaseTestCase):
    def test_admin_creates_ticket(self):
        r = self.create_ticket()
        self.assertEqual(r.status_code, 201)
        data = r.get_json()
        self.assertEqual(data['ticket_number'], 'ICT-00001')

        detail = self.client.get(f"/api/tickets/{_latest_ticket().id}", headers=self.admin_headers())
        self.assertEqual(detail.get_json()['priority'], 'high')
        self.assertIn('sla_response_due', detail.get_json())

    def test_staff_creates_ticket(self):
        r = self.create_ticket(headers=self.staff_headers())
        self.assertEqual(r.status_code, 201)
        self.assertEqual(_latest_ticket().created_by, 'staff')

    def test_missing_title(self):
        r = self.client.post('/api/tickets', json={}, headers=self.admin_headers())
        self.assertEqual(r.status_code, 400)

    def test_requires_auth(self):
        r = self.client.post('/api/tickets', json={'title': 'x', 'description': 'y'})
        self.assertEqual(r.status_code, 401)


class ListTicketsTestCase(BaseTestCase):
    def test_admin_sees_all_tickets(self):
        self.create_ticket()
        self.create_ticket(headers=self.staff_headers())
        r = self.client.get('/api/tickets', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.get_json()), 2)

    def test_staff_sees_only_own_tickets(self):
        self.create_ticket()  # admin's ticket
        self.create_ticket(headers=self.staff_headers())
        r = self.client.get('/api/tickets', headers=self.staff_headers())
        self.assertEqual(len(r.get_json()), 1)

    def test_priority_filtering_not_server_side(self):
        # The web UI filters the (already scoped) list client-side; the API does
        # not accept a priority query parameter. Both tickets are returned.
        self.create_ticket(priority='low')
        r = self.client.get('/api/tickets?priority=low', headers=self.admin_headers())
        self.assertEqual(len(r.get_json()), 1)


class UpdateTicketTestCase(BaseTestCase):
    def test_admin_updates_ticket(self):
        self.create_ticket()
        tid = _latest_ticket().id
        r = self.client.put(f'/api/tickets/{tid}',
                            json={'status': 'resolved', 'resolution': 'Rebooted the MFP'},
                            headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)

        detail = self.client.get(f'/api/tickets/{tid}', headers=self.admin_headers())
        self.assertEqual(detail.get_json()['status'], 'resolved')
        self.assertEqual(detail.get_json()['resolution'], 'Rebooted the MFP')

    def test_staff_cannot_put_other_users_ticket(self):
        self.create_ticket()  # admin-created
        tid = _latest_ticket().id
        r = self.client.put(f'/api/tickets/{tid}', json={'status': 'resolved'}, headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_staff_cannot_view_other_users_ticket(self):
        self.create_ticket()  # admin-created
        tid = _latest_ticket().id
        r = self.client.get(f'/api/tickets/{tid}', headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_admin_can_view_any_ticket(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id
        r = self.client.get(f'/api/tickets/{tid}', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)


class CommentsTestCase(BaseTestCase):
    def test_add_and_list_comments(self):
        self.create_ticket()
        tid = _latest_ticket().id
        r = self.client.post(f'/api/tickets/{tid}/comments',
                             json={'message': 'Assigned to the network team'},
                             headers=self.admin_headers())
        self.assertEqual(r.status_code, 201)

        comments = self.client.get(f'/api/tickets/{tid}/comments', headers=self.admin_headers())
        self.assertEqual(comments.status_code, 200)
        self.assertEqual(comments.get_json()[0]['message'], 'Assigned to the network team')

    def test_comment_on_other_users_ticket_forbidden(self):
        self.create_ticket()  # admin-created
        tid = _latest_ticket().id
        r = self.client.post(f'/api/tickets/{tid}/comments',
                             json={'message': 'sneaky'},
                             headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)


class DeleteTicketTestCase(BaseTestCase):
    def test_admin_deletes_ticket(self):
        self.create_ticket()
        tid = _latest_ticket().id
        delete_r = self.client.delete(f'/api/tickets/{tid}', headers=self.admin_headers())
        self.assertEqual(delete_r.status_code, 200)
        r = self.client.get('/api/tickets', headers=self.admin_headers())
        self.assertEqual(len(r.get_json()), 0)

class InternalNotesTestCase(BaseTestCase):
    """Internal Notes vs. Public Replies (is_internal on TicketComment)."""

    def test_staff_cannot_set_is_internal(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id
        r = self.client.post(f'/api/tickets/{tid}/comments',
                             json={'message': 'sneaky internal', 'is_internal': True},
                             headers=self.staff_headers())
        self.assertEqual(r.status_code, 403)

    def test_staff_cannot_read_internal_comments(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id

        internal = self.client.post(f'/api/tickets/{tid}/comments',
                                    json={'message': 'Note for the ICT team only',
                                          'is_internal': True},
                                    headers=self.admin_headers())
        self.assertEqual(internal.status_code, 201)

        staff_view = self.client.get(f'/api/tickets/{tid}/comments', headers=self.staff_headers())
        self.assertEqual(staff_view.status_code, 200)
        self.assertEqual(staff_view.get_json(), [])

    def test_admin_reads_internal_comments_with_flag(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id
        self.client.post(f'/api/tickets/{tid}/comments',
                         json={'message': 'First internal note', 'is_internal': True},
                         headers=self.admin_headers())
        self.client.post(f'/api/tickets/{tid}/comments',
                         json={'message': 'Visible public reply'},
                         headers=self.admin_headers())

        admin_view = self.client.get(f'/api/tickets/{tid}/comments', headers=self.admin_headers())
        comments = admin_view.get_json()
        self.assertEqual(len(comments), 2)
        internal = [c for c in comments if c['is_internal']]
        self.assertEqual(len(internal), 1)
        self.assertEqual(internal[0]['message'], 'First internal note')

    def test_public_comment_has_flag_false(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id
        self.client.post(f'/api/tickets/{tid}/comments',
                         json={'message': 'ordinary reply'},
                         headers=self.admin_headers())
        comments = self.client.get(f'/api/tickets/{tid}/comments', headers=self.staff_headers()).get_json()
        self.assertFalse(comments[0]['is_internal'])

    def test_internal_note_does_not_notify_requester(self):
        self.create_ticket(headers=self.staff_headers())
        tid = _latest_ticket().id

        self.client.post(f'/api/tickets/{tid}/comments',
                         json={'message': 'quiet internal note', 'is_internal': True},
                         headers=self.admin_headers())
        self.assertEqual(
            Notification.query.filter_by(type='technician_reply').count(), 0)

        self.client.post(f'/api/tickets/{tid}/comments',
                         json={'message': 'public reply, should notify'},
                         headers=self.admin_headers())
        self.assertGreater(
            Notification.query.filter_by(type='technician_reply').count(), 0)


class TicketNumberingTestCase(BaseTestCase):
    """Next-number derivation is shared, prefix-scoped and immune to stray
    malformed ticket_number values (they used to derail the old 'latest row
    by id' logic: a crash in v1, guaranteed collisions elsewhere)."""

    def _seed(self, ticket_number):
        t = Ticket(ticket_number=ticket_number,
                   title='seed', description='seed', category='other', created_by='seed')
        db.session.add(t)
        db.session.commit()

    def test_sequential_numbering(self):
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00001')
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00002')

    def test_non_matching_prefix_does_not_shift_sequence(self):
        self._seed('OPS-1')
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00001')

    def test_malformed_suffix_ignored(self):
        self._seed('ICT-abc')
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00001')

    def test_max_matching_suffix_wins(self):
        self._seed('ICT-00005')
        self._seed('ICT-00002')
        self._seed('ICT-abc')
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00006')
        self.assertEqual(self.create_ticket().get_json()['ticket_number'], 'ICT-00007')

    def test_new_number_never_collides_with_live_ticket(self):
        self.create_ticket()  # ICT-00001
        self.create_ticket()  # ICT-00002
        newest = _latest_ticket().id
        r = self.client.delete(f'/api/tickets/{newest}', headers=self.admin_headers())
        self.assertEqual(r.status_code, 200)
        live_before = {t.ticket_number for t in Ticket.query.all()}
        r = self.create_ticket()
        self.assertEqual(r.status_code, 201)
        num = r.get_json()['ticket_number']
        self.assertNotIn(num, live_before)
        self.assertEqual(num, 'ICT-00002')
