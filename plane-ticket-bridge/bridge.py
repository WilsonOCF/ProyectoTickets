"""Private, version-pinned integration. Only the tickets backend may call this.

Uses Plane's serializer and audit context, without modifying the upstream image's
code or accepting a caller-supplied Plane user ID. Users and tickets commit in one
transaction. PostgreSQL locks serialize retries across workers and restarts.
"""
import hashlib
import hmac
import json
import logging
import os
import uuid
from http import HTTPStatus

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "plane.settings.production")
import django
django.setup()

from crum import impersonate
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import close_old_connections, connection, transaction, IntegrityError
from django.utils import timezone
from plane.api.serializers import IssueSerializer
from plane.db.models import User, Profile, Workspace, WorkspaceMember, Project, ProjectMember, Issue
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.webhook_task import model_activity

log = logging.getLogger("plane.tickets_bridge")
SECRET = os.environ.get("TICKETS_BRIDGE_SECRET", "")
WORKSPACE = os.environ.get("PLANE_WORKSPACE_SLUG", "")
if len(SECRET) < 32 or not WORKSPACE:
    raise RuntimeError("TICKETS_BRIDGE_SECRET (32+ chars) and PLANE_WORKSPACE_SLUG are required")


class Rejected(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def lock(value):
    key = int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big", signed=True)
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [key])


def ensure_member(model, lookup, defaults):
    # Respect revocation: a disabled/deleted membership must not be silently restored.
    member = model._base_manager.filter(**lookup).first()
    if member:
        if not member.is_active or getattr(member, "deleted_at", None):
            raise Rejected("Tu acceso a este proyecto está suspendido. Contacta al administrador.", 403)
        if member.role < defaults["role"]:
            raise Rejected("Tu cuenta no tiene permisos para enviar a este proyecto.", 403)
        return member
    return model.objects.create(**lookup, **defaults)


def publish_activity(issue_id, project_id, user_id, payload):
    # Called after commit so workers always see the newly created identity and item.
    try:
        origin = os.environ.get("WEB_URL", "")
        issue_activity.delay(
            type="issue.activity.created", requested_data=json.dumps(payload),
            actor_id=user_id, issue_id=issue_id, project_id=project_id,
            current_instance=None, epoch=int(timezone.now().timestamp()), notification=True, origin=origin,
        )
        model_activity.delay(
            model_name="issue", model_id=issue_id, requested_data=payload,
            current_instance=None, actor_id=user_id, slug=WORKSPACE, origin=origin,
        )
    except Exception:
        # Never report a committed ticket as failed (which would invite duplicate submissions).
        log.exception("Ticket committed but activity publication failed: %s", issue_id)


def create_ticket(data):
    try:
        portal_user = data["user"]
        portal_id = str(uuid.UUID(portal_user["id"]))
        request_id = str(uuid.UUID(data["request_id"]))
        project_id = str(uuid.UUID(data["project_id"]))
        email = portal_user["email"].strip().lower()
        display_name = portal_user["display_name"].strip()
        fingerprint = data["fingerprint"]
        validate_email(email)
        if not (2 <= len(display_name) <= 120) or len(email) > 254:
            raise ValueError()
        if not isinstance(fingerprint, str) or len(fingerprint) != 64 or any(c not in "0123456789abcdef" for c in fingerprint):
            raise ValueError()
        if not isinstance(data["name"], str) or not (1 <= len(data["name"].strip()) <= 255):
            raise ValueError()
        if data["priority"] not in {"urgent", "high", "medium", "low", "none"}:
            raise ValueError()
        if not isinstance(data["description_html"], str) or len(data["description_html"]) > 200000:
            raise ValueError()
    except (KeyError, ValueError, TypeError, AttributeError, ValidationError):
        raise Rejected("Los datos del envío no son válidos.")

    external_id = f"{portal_id}:{request_id}"
    with transaction.atomic():
        # Serialize provisioning of the same person (including concurrent first submissions).
        lock(f"tickets-user:{portal_id}")
        lock(f"tickets-email:{email}")
        workspace = Workspace.objects.filter(slug=WORKSPACE).first()
        project = Project.objects.filter(id=project_id, workspace=workspace).first() if workspace else None
        if not project or getattr(project, "archived_at", None):
            raise Rejected("El proyecto ya no está disponible.", 422)
        username = f"tickets_{portal_id}"
        user = User.objects.filter(username=username).first()
        if user:
            if user.email != email or not user.is_active:
                raise Rejected("La vinculación de tu cuenta necesita revisión del administrador.", 409)
        else:
            if User.objects.filter(email__iexact=email).exists():
                raise Rejected("Ese correo ya tiene una cuenta previa en el sistema de soporte. Contacta al administrador para vincularla; no se modificó esa cuenta.", 409)
            user = User(username=username, email=email, display_name=display_name,
                        first_name=display_name, is_password_autoset=True)
            user.set_unusable_password()
            user.save()
            Profile.objects.get_or_create(user=user)

        # Workspace guest + member only in requested projects; never workspace admin.
        ensure_member(WorkspaceMember, {"workspace": workspace, "member": user}, {"role": 5})
        ensure_member(ProjectMember, {"project": project, "member": user}, {"workspace": workspace, "role": 15})

        previous = Issue._base_manager.filter(workspace=workspace, external_id=external_id).first()
        if previous:
            if (str(previous.project_id) != project_id or previous.created_by_id != user.id
                    or previous.external_source != f"tickets-portal:{fingerprint}"
                    or getattr(previous, "deleted_at", None)):
                raise Rejected("El envío ya existe con otros datos o fue retirado. Contacta al administrador.", 409)
            issue = previous
        else:
            payload = {key: data[key] for key in ("name", "priority", "description_html")}
            payload.update(external_id=external_id, external_source=f"tickets-portal:{fingerprint}")
            with impersonate(user):
                serializer = IssueSerializer(data=payload, context={
                    "project_id": project.id, "workspace_id": workspace.id,
                    "default_assignee_id": project.default_assignee_id,
                })
                if not serializer.is_valid():
                    raise Rejected("El contenido del ticket no es válido para este proyecto.", 422)
                issue = serializer.save()
                issue.refresh_from_db()
                if issue.created_by_id != user.id:
                    raise RuntimeError("Plane serializer did not preserve author")
            transaction.on_commit(lambda: publish_activity(str(issue.id), project_id, str(user.id), payload))

        return {"id": str(issue.id), "project_id": project_id,
                "identifier": f"{project.identifier}-{issue.sequence_id}",
                "sequence_id": issue.sequence_id, "name": issue.name, "priority": issue.priority,
                "created_by": str(user.id), "created_by_name": user.display_name}


def application(environ, start_response):
    close_old_connections()
    status, result = 200, {}
    try:
        if environ.get("PATH_INFO") == "/healthz" and environ.get("REQUEST_METHOD") == "GET":
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
            result = {"ok": True}
        elif not hmac.compare_digest(environ.get("HTTP_AUTHORIZATION", ""), f"Bearer {SECRET}"):
            raise Rejected("Unauthorized", 401)
        elif environ.get("PATH_INFO") != "/tickets" or environ.get("REQUEST_METHOD") != "POST":
            raise Rejected("Not found", 404)
        else:
            length = int(environ.get("CONTENT_LENGTH") or "0")
            if not 0 < length <= 1024 * 1024:
                raise Rejected("Request too large or empty", 413)
            data = json.loads(environ["wsgi.input"].read(length))
            if not isinstance(data, dict):
                raise Rejected("Invalid JSON")
            result = create_ticket(data)
    except Rejected as error:
        status, result = error.status, {"error": str(error)}
    except (ValueError, json.JSONDecodeError):
        status, result = 400, {"error": "Invalid request"}
    except IntegrityError:
        status, result = 409, {"error": "No se pudo vincular la cuenta. Contacta al administrador."}
    except Exception:
        log.exception("Tickets bridge failed")
        status, result = 503, {"error": "No se pudo completar el envío. Intenta nuevamente."}
    finally:
        close_old_connections()
    body = json.dumps(result).encode()
    start_response(f"{status} {HTTPStatus(status).phrase}", [
        ("Content-Type", "application/json"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"),
    ])
    return [body]
