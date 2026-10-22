"""Run in the bridge container of the isolated test stack."""
import concurrent.futures
import hashlib
import io
import json
import os
import uuid
assert os.environ.get("PORTAL_TEST_SEED") == "tickets-portal-check"
import bridge
from plane.db.models import User, Issue, WorkspaceMember, ProjectMember, Project

project = Project.objects.get(workspace__slug="crs", identifier="SUP")
portal_id = str(uuid.uuid4())
data = {"user": {"id": portal_id, "email": f"bridge-{portal_id}@example.test", "display_name": "Concurrent Reporter"},
        "request_id": str(uuid.uuid4()), "project_id": str(project.id), "fingerprint": hashlib.sha256(portal_id.encode()).hexdigest(),
        "name": "Concurrent retries", "priority": "medium", "description_html": "<p>Valid content</p>"}
assert not User.objects.filter(email=data["user"]["email"]).exists()

# Real WSGI authorization check: public calls cannot provision identities.
status = []
body = json.dumps(data).encode()
response = bridge.application({"PATH_INFO": "/tickets", "REQUEST_METHOD": "POST", "CONTENT_LENGTH": str(len(body)), "wsgi.input": io.BytesIO(body)}, lambda value, headers: status.append(value))
assert status[0].startswith("401"), response
assert not User.objects.filter(email=data["user"]["email"]).exists()

def submit():
    # Separate DB connections, as with separate Gunicorn workers.
    from django.db import connections
    try:
        return bridge.create_ticket(data)
    finally:
        connections.close_all()

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(lambda _: submit(), range(3)))
assert len({result["id"] for result in results}) == 1
user = User.objects.get(email=data["user"]["email"])
assert Issue.objects.filter(created_by=user).count() == 1

# Suspension must not be silently undone by a retry/new request.
ProjectMember.objects.filter(member=user, project=project).update(is_active=False)
data["request_id"] = str(uuid.uuid4())
try:
    bridge.create_ticket(data)
    raise AssertionError("Suspended membership was accepted")
except bridge.Rejected as error:
    assert error.status == 403
assert not ProjectMember.objects.get(member=user, project=project).is_active

# Invalid content rolls back identity/memberships along with the work item.
invalid_id = str(uuid.uuid4())
data["user"] = {"id": invalid_id, "email": f"invalid-{invalid_id}@example.test", "display_name": "Invalid Request"}
data["project_id"] = str(uuid.uuid4())
try:
    bridge.create_ticket(data)
    raise AssertionError("Unknown project was accepted")
except bridge.Rejected as error:
    assert error.status == 422
assert not User.objects.filter(email=data["user"]["email"]).exists()
print("PASS: private endpoint authentication, concurrent retries, membership revocation, invalid-project rollback")
