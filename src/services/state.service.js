const sessions = {};

export function getUserState(phone) {
  return sessions[phone] || { step: "newUser" };
}

export function updateUserState(phone, updates) {
  sessions[phone] = { ...getUserState(phone), ...updates };
}
