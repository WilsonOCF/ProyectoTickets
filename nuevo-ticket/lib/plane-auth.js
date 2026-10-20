const { CookieJar } = require("tough-cookie");
const fetchCookie = require("fetch-cookie").default;
const { PLANE_API_URL } = require("./config");

function createPlaneClient(serializedJar) {
  const jar = serializedJar
    ? CookieJar.fromJSON(serializedJar)
    : new CookieJar();
  const fetch = fetchCookie(globalThis.fetch, jar);
  return { jar, fetch };
}

async function fetchMe(fetch) {
  const res = await fetch(`${PLANE_API_URL}/api/users/me/`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw new Error(`No se pudo leer /api/users/me/ (${res.status})`);
  }
  return res.json();
}

/**
 * Login email/password contra Plane Community.
 * Devuelve { user, jarJson } para guardar en la sesión del formulario.
 */
async function loginWithPassword(email, password) {
  const { jar, fetch } = createPlaneClient();

  const csrfRes = await fetch(`${PLANE_API_URL}/auth/get-csrf-token/`, {
    headers: { Accept: "application/json" },
  });
  if (!csrfRes.ok) {
    throw new Error(
      `Plane no responde en ${PLANE_API_URL}. ¿Está levantada la API?`
    );
  }
  const csrfData = await csrfRes.json();
  const cookieHeader = await jar.getCookieString(PLANE_API_URL);
  const csrfFromCookie = /csrftoken=([^;]+)/.exec(cookieHeader)?.[1];
  const csrf = csrfFromCookie || csrfData.csrf_token;

  const body = new URLSearchParams({
    email: String(email).trim().toLowerCase(),
    password: String(password),
  });

  const loginRes = await fetch(`${PLANE_API_URL}/auth/sign-in/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrf,
      Referer: `${PLANE_API_URL}/`,
      Origin: PLANE_API_URL,
    },
    body,
    redirect: "manual",
  });

  const location = loginRes.headers.get("location") || "";
  if (
    /error_code|USER_DOES_NOT_EXIST|AUTHENTICATION|INVALID|REQUIRED/i.test(
      location
    )
  ) {
    throw new Error(
      "Email o contraseña incorrectos, o la cuenta no existe en Plane."
    );
  }

  if (loginRes.status >= 400 && loginRes.status !== 302) {
    throw new Error(`Login Plane falló (${loginRes.status})`);
  }

  const user = await fetchMe(fetch);
  if (!user || !user.id) {
    throw new Error(
      "Plane no devolvió sesión. Revisá email/contraseña."
    );
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name || user.first_name || user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
    jarJson: jar.toJSON(),
  };
}

async function validateSession(jarJson) {
  if (!jarJson) return null;
  const { fetch } = createPlaneClient(jarJson);
  return fetchMe(fetch);
}

module.exports = {
  loginWithPassword,
  validateSession,
  createPlaneClient,
};
