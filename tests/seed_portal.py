"""Seed only the disposable tickets-portal-check database, never the user's stack."""
import os
assert os.environ.get("PORTAL_TEST_SEED") == "tickets-portal-check", "Explicit test guard required"
import django
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")
django.setup()
from plane.db.models import User, Profile, Workspace, WorkspaceMember, Project, ProjectMember, APIToken, State
from crum import impersonate

owner, _ = User.objects.get_or_create(email="portal-owner@example.test", defaults={"username": "portal-test-owner", "display_name": "Test Owner"})
owner.set_password("portal-owner-test-password-123")
owner.save()
Profile.objects.get_or_create(user=owner)
with impersonate(owner):
    workspace, _ = Workspace.objects.get_or_create(slug="crs", defaults={"name": "Portal integration test", "owner": owner})
    WorkspaceMember.objects.get_or_create(workspace=workspace, member=owner, defaults={"role": 20})
    for identifier in ["SUP", "OPS"]:
        project, _ = Project.objects.get_or_create(workspace=workspace, identifier=identifier, defaults={"name": identifier, "created_by": owner})
        ProjectMember.objects.get_or_create(workspace=workspace, project=project, member=owner, defaults={"role": 20})
        State.objects.get_or_create(workspace=workspace, project=project, name="Todo", defaults={"group": "unstarted", "default": True, "color": "#808080"})
    APIToken.objects.get_or_create(token="plane_api_portal_integration_test_only", defaults={"user": owner, "workspace": workspace})
    Profile.objects.filter(user=owner).update(is_onboarded=True, last_workspace_id=workspace.id)
from plane.license.models import Instance
Instance.objects.update(is_setup_done=True)
from django.core.cache import cache
cache.clear()
print("Test workspace and two projects ready")
