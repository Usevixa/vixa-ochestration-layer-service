// services/session.service.js
// Simple in-memory session store for development.
// Swap out for Redis (or other persistent store) in production.

const IN_MEMORY = {};

function DEFAULT_SESSION() {
  return {
    step: "ENTRY",
    data: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function getSession(phone) {
  if (!IN_MEMORY[phone]) IN_MEMORY[phone] = DEFAULT_SESSION();
  return IN_MEMORY[phone];
}

export async function updateSession(phone, patch) {
  const current = await getSession(phone);
  const next = {
    ...current,
    ...patch,
    data: { ...(current.data || {}), ...(patch.data || {}) },
    updatedAt: Date.now(),
  };
  IN_MEMORY[phone] = next;
  return next;
}

export async function clearSession(phone) {
  delete IN_MEMORY[phone];
}
